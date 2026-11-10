'use strict';
// One blank Markdown line separates blocks. Each additional interior blank
// line becomes one empty paragraph. null is internal only, never stored.
function exportLines(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let blanks = 0;
  let seen = false;
  for (const line of lines) {
    if (/^\s*$/.test(line)) { blanks += 1; continue; }
    if (seen && blanks) {
      out.push('');
      for (let i = 1; i < blanks; i += 1) out.push(null);
    }
    out.push(line);
    blanks = 0;
    seen = true;
  }
  return out;
}
module.exports = { exportLines };
