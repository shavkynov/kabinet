// Headless plugin-state tests, not WebView, clipboard, DOM or Markdown integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth, redoDepth } from '@tiptap/pm/history';
import { Comments, addCommentRange, removeCommentRange, setActiveComment, commentRanges } from '../../renderer/comments.js';
import { HiddenMarks, marksKey, refreshMarks } from '../../renderer/marks.js';

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' },
  paragraph: { content: 'text*', group: 'block' },
  text: { group: 'inline' },
} });

function harness(extension, options = {}) {
  const plugins = extension.config.addProseMirrorPlugins.call({ options });
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('alpha beta gamma'))]);
  let state = EditorState.create({ schema, doc, plugins: [history(), ...plugins] });
  const editor = {
    get state() { return state; },
    view: { dispatch(tr) { state = state.apply(tr); } },
  };
  return editor;
}

function snapshot(editor) {
  return { doc: editor.state.doc.toJSON(), undo: undoDepth(editor.state), redo: redoDepth(editor.state) };
}

test('comment add, activate and remove preserve document and undo/redo depths', () => {
  const editor = harness(Comments);
  editor.view.dispatch(editor.state.tr.insertText('!', 17));
  const before = snapshot(editor);
  assert.equal(before.undo, 1);
  addCommentRange(editor, { id: 'a', from: 7, to: 11 });
  assert.deepEqual(commentRanges(editor.state), { a: { from: 7, to: 11 } });
  assert.deepEqual(snapshot(editor), before);
  setActiveComment(editor, 'a');
  assert.deepEqual(snapshot(editor), before);
  removeCommentRange(editor, 'a');
  assert.deepEqual(commentRanges(editor.state), {});
  assert.deepEqual(snapshot(editor), before);
  assert.equal(undo(editor.state, editor.view.dispatch), true);
  assert.equal(editor.state.doc.textContent, 'alpha beta gamma');
  const afterUndo = snapshot(editor);
  addCommentRange(editor, { id: 'b', from: 7, to: 11 });
  removeCommentRange(editor, 'b');
  assert.deepEqual(snapshot(editor), afterUndo);
});

test('comment range follows insertion before and inside the anchor', () => {
  const editor = harness(Comments);
  addCommentRange(editor, { id: 'a', from: 7, to: 11 });
  editor.view.dispatch(editor.state.tr.insertText('XX', 1));
  assert.deepEqual(commentRanges(editor.state), { a: { from: 9, to: 13 } });
  editor.view.dispatch(editor.state.tr.insertText('Y', 10));
  assert.deepEqual(commentRanges(editor.state), { a: { from: 9, to: 14 } });
  assert.equal(editor.state.doc.textBetween(9, 14), 'bYeta');
});

test('deleting the whole commented fragment removes its decoration', () => {
  const editor = harness(Comments);
  addCommentRange(editor, { id: 'a', from: 7, to: 11 });
  editor.view.dispatch(editor.state.tr.delete(7, 11));
  assert.deepEqual(commentRanges(editor.state), {});
  assert.equal(editor.state.doc.textContent, 'alpha  gamma');
});

test('hidden mark toggles preserve document and history; decorations follow edits', () => {
  const options = { on: false, spaces: true };
  const editor = harness(HiddenMarks, { getOptions: () => options });
  editor.view.dispatch(editor.state.tr.insertText('!', 17));
  const before = snapshot(editor);
  assert.equal(marksKey.getState(editor.state).set.find().length, 0);
  options.on = true;
  refreshMarks(editor);
  assert.equal(marksKey.getState(editor.state).set.find().length, 3);
  assert.deepEqual(snapshot(editor), before);
  options.spaces = false;
  refreshMarks(editor);
  assert.equal(marksKey.getState(editor.state).set.find().length, 1);
  assert.deepEqual(snapshot(editor), before);
  options.spaces = true;
  refreshMarks(editor);
  editor.view.dispatch(editor.state.tr.insertText(' ', 1));
  assert.equal(marksKey.getState(editor.state).set.find().length, 4);
  const afterEdit = snapshot(editor);
  options.on = false;
  refreshMarks(editor);
  assert.equal(marksKey.getState(editor.state).set.find().length, 0);
  assert.deepEqual(snapshot(editor), afterEdit);
});
