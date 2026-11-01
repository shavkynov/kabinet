// Focus and background isolation shared by Android modal sheets.
let sequence = 0;
const stack = [];
const saved = new Map();
const restore = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
const top = () => stack[stack.length - 1];
const focus = (node) => { if (node && node.isConnected && !node.disabled) node.focus({ preventScroll: true }); };
function syncBackground() {
  for (const node of document.body.children) {
    if (!saved.has(node)) saved.set(node, { inert: node.getAttribute('inert'), hidden: node.getAttribute('aria-hidden') });
    const state = saved.get(node);
    if (top() && node !== top().modal) {
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
    } else {
      restore(node, 'inert', state.inert);
      restore(node, 'aria-hidden', state.hidden);
    }
  }
  if (!top()) {
    for (const [node, state] of saved) {
      restore(node, 'inert', state.inert);
      restore(node, 'aria-hidden', state.hidden);
    }
    saved.clear();
  }
}
function controls(sheet) {
  return [...sheet.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter((node) => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]') && node.getClientRects().length);
}
function onKey(event) {
  const current = top();
  if (!current || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    current.cancel();
  } else if (event.key === 'Tab') {
    const list = controls(current.sheet);
    const index = list.indexOf(document.activeElement);
    if (!list.length || index < 0 || (!event.shiftKey && index === list.length - 1) || (event.shiftKey && index === 0)) {
      event.preventDefault();
      focus(list.length ? list[event.shiftKey ? list.length - 1 : 0] : current.sheet);
    }
  }
}
function onFocus(event) {
  const current = top();
  if (current && !current.sheet.contains(event.target)) focus(current.sheet);
}
function onCancel(event) {
  if (top() && stack.some((entry) => entry.modal === event.target)) {
    event.stopImmediatePropagation();
    top().cancel();
  }
}
export function activateModal(modal, sheet, cancel) {
  const previous = document.activeElement;
  const heading = sheet.querySelector('h2');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.tabIndex = -1;
  if (heading) {
    if (!heading.id) heading.id = `mob-dialog-title-${++sequence}`;
    sheet.setAttribute('aria-labelledby', heading.id);
  }
  const current = { modal, sheet, cancel };
  if (!stack.length) {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mob-cancel', onCancel, true);
    document.addEventListener('focusin', onFocus, true);
  }
  stack.push(current);
  focus(sheet);
  syncBackground();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const wasTop = top() === current;
    stack.splice(stack.indexOf(current), 1);
    syncBackground();
    if (!top()) {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mob-cancel', onCancel, true);
      document.removeEventListener('focusin', onFocus, true);
    }
    if (wasTop) {
      const valid = previous && previous.isConnected && !previous.closest('[hidden], [inert], [aria-hidden="true"]');
      focus(valid && (!top() || top().sheet.contains(previous)) ? previous : top()?.sheet);
    }
  };
}
