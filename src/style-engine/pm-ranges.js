'use strict';

// Адаптер structural findings → ProseMirror ranges.
// Работает только с реальным ProseMirror Node/Schema и не создаёт Decorations.
// Парсер получает ровно snapshot.text; offsets findings относятся к нему.

const { validateFinding } = require('./contract');

const BLOCK_SEPARATOR = '\n\n';
const LEAF_TEXT = '\n';

function isAnalyzableTextblock(node) {
  return node.isTextblock && node.type.name !== 'codeBlock' && node.content.size > 0;
}

function makeSegment(parserStart, pmStart, node) {
  return {
    parserStart,
    parserEnd: parserStart,
    pmStart,
    text: '',
    analyzable: isAnalyzableTextblock(node),
    runs: [],
    charMap: [],
  };
}

/** Полный текст и таблица сегментов, соответствующие doc.textBetween(..., '\n\n', '\n'). */
function createDocumentSnapshot(doc) {
  if (!doc || typeof doc.textBetween !== 'function' || !doc.content) {
    throw new TypeError('createDocumentSnapshot: нужен ProseMirror Node');
  }
  const text = doc.textBetween(0, doc.content.size, BLOCK_SEPARATOR, LEAF_TEXT);
  const segments = [];
  let built = '';
  let firstBlock = true;

  function walk(node, pos, segment) {
    const leafText = node.isLeaf ? LEAF_TEXT : '';
    const isTextualBlock = node.isBlock && ((node.isLeaf && leafText) || node.isTextblock);
    if (isTextualBlock) {
      if (!firstBlock) built += BLOCK_SEPARATOR;
      else firstBlock = false;
    }

    if (node.isText) {
      const textStart = built.length;
      built += node.text;
      if (segment) segment.runs.push({ textStart, textEnd: built.length, pmStart: pos });
      return;
    }
    if (node.isLeaf) {
      built += leafText;
      return;
    }

    let own = segment;
    if (node.isTextblock) {
      own = makeSegment(built.length, pos + 1, node);
      segments.push(own);
    }
    node.forEach((child, offset) => walk(child, pos + 1 + offset, own));
    if (node.isTextblock) {
      own.parserEnd = built.length;
      own.text = built.slice(own.parserStart, own.parserEnd);
      own.charMap = new Array(own.text.length).fill(-1);
      for (const run of own.runs) {
        for (let i = run.textStart; i < run.textEnd; i += 1) {
          own.charMap[i - own.parserStart] = run.pmStart + (i - run.textStart);
        }
      }
    }
  }

  walk(doc, -1, null);
  if (built !== text) {
    throw new Error('createDocumentSnapshot: таблица сегментов не совпала с doc.textBetween');
  }
  return { doc, text, segments };
}

function sameDocument(snapshot, currentDoc) {
  return typeof snapshot.doc.eq === 'function' ? snapshot.doc.eq(currentDoc) : snapshot.doc === currentDoc;
}

function segmentFor(snapshot, start, end) {
  for (const segment of snapshot.segments) {
    if (start >= segment.parserStart && start < segment.parserEnd) {
      if (end <= segment.parserEnd) return { segment };
      return { error: 'crosses-segment' };
    }
    if (start === segment.parserStart && start === segment.parserEnd) return { error: 'empty-block' };
  }
  return { error: 'outside-segment' };
}

/**
 * findings: [{ category, start, end, fragment, ... }].
 * currentDoc: обязательный актуальный doc; если не передан или не равен snapshot.doc — результат отбрасывается.
 * Возвращает { ranges, diagnostics, droppedNested }.
 */
function findingsToRanges(snapshotOrDoc, findings, currentDoc) {
  const snapshot = snapshotOrDoc && Array.isArray(snapshotOrDoc.segments)
    ? snapshotOrDoc
    : createDocumentSnapshot(snapshotOrDoc);
  const diagnostics = [];
  if (!currentDoc) {
    return { ranges: [], diagnostics: [{ code: 'missing-current-document', message: 'нужен актуальный ProseMirror document' }], droppedNested: 0 };
  }
  if (!Array.isArray(findings)) {
    return { ranges: [], diagnostics: [{ code: 'invalid-findings', message: 'findings должен быть массивом' }], droppedNested: 0 };
  }
  if (!sameDocument(snapshot, currentDoc)) {
    return { ranges: [], diagnostics: [{ code: 'document-changed', message: 'документ изменился после снимка' }], droppedNested: 0 };
  }

  const mapped = [];
  findings.forEach((finding, index) => {
    const check = validateFinding(snapshot.text, finding);
    if (!check.valid) {
      diagnostics.push({ index, code: 'invalid-finding', errors: check.errors });
      return;
    }
    const found = segmentFor(snapshot, finding.start, finding.end);
    if (found.error) {
      diagnostics.push({ index, code: found.error, message: 'finding не принадлежит одному анализируемому textblock' });
      return;
    }
    const segment = found.segment;
    if (!segment.analyzable) {
      diagnostics.push({ index, code: 'skipped-block', message: 'codeBlock или пустой блок не анализируется' });
      return;
    }
    const localStart = finding.start - segment.parserStart;
    const localEnd = finding.end - segment.parserStart;
    if (segment.charMap.slice(localStart, localEnd).some((pos) => pos < 0)) {
      diagnostics.push({ index, code: 'leaf-boundary', message: 'finding пересекает hard break/inline leaf' });
      return;
    }
    const from = segment.charMap[localStart];
    const toBase = segment.charMap[localEnd - 1];
    if (!Number.isInteger(from) || !Number.isInteger(toBase)) {
      diagnostics.push({ index, code: 'leaf-boundary', message: 'finding пересекает hard break/inline leaf' });
      return;
    }
    const to = toBase + 1;
    if (from < 0 || to <= from || to > snapshot.doc.content.size) {
      diagnostics.push({ index, code: 'invalid-prosemirror-range' });
      return;
    }
    const actual = snapshot.doc.textBetween(from, to, '', '');
    if (actual !== finding.fragment) {
      diagnostics.push({ index, code: 'fragment-mismatch', message: 'textBetween не совпал с fragment' });
      return;
    }
    mapped.push({
      from,
      to,
      category: finding.category,
      ruleId: finding.ruleId,
      fragment: finding.fragment,
      finding,
    });
  });

  // Внутри одной категории диапазоны должны быть непересекающимися:
  // вложенные и частично пересекающиеся findings сливаются в детерминированный
  // внешний диапазон. Разные категории не смешиваются.
  const kept = [];
  let droppedNested = 0;
  let mergedOverlaps = 0;
  for (const range of mapped.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const overlapping = kept.filter((other) => other.category === range.category
      && range.from <= other.to && range.to >= other.from);
    if (!overlapping.length) {
      kept.push({ ...range, sources: [range] });
      continue;
    }
    const from = Math.min(range.from, ...overlapping.map((x) => x.from));
    const to = Math.max(range.to, ...overlapping.map((x) => x.to));
    const group = [range, ...overlapping];
    const primary = group.slice().sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)[0];
    for (const old of overlapping) kept.splice(kept.indexOf(old), 1);
    kept.push({
      ...primary,
      from,
      to,
      fragment: snapshot.doc.textBetween(from, to, '', ''),
      sources: group.flatMap((item) => item.sources || [item]),
    });
    droppedNested += group.length - 1;
    mergedOverlaps += group.length - 1;
  }
  return { ranges: kept.sort((a, b) => a.from - b.from || a.to - b.to), diagnostics, droppedNested, mergedOverlaps };
}

module.exports = { createDocumentSnapshot, findingsToRanges, BLOCK_SEPARATOR, LEAF_TEXT };
