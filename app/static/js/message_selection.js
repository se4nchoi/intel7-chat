// One shared selection guard: never prevent the browser's native text selection.
let installed = false;
let dragging = false;

export function hasMessageTextSelection() {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && (
    selection.anchorNode?.parentElement?.closest('.msg-bubble') ||
    selection.focusNode?.parentElement?.closest('.msg-bubble')
  ));
}

export function messageActionsBlocked() {
  return dragging || hasMessageTextSelection();
}

export function initMessageSelectionGuard() {
  if (installed) return;
  installed = true;
  const refresh = () => document.body.classList.toggle('message-selection-active', messageActionsBlocked());
  document.addEventListener('pointerdown', event => {
    document.querySelectorAll('.message-actions').forEach(el => {
      const parentRow = el.closest('.msg-row');
      if ((!parentRow || !parentRow.contains(event.target)) && !el.classList.contains('has-open-menu')) {
        el.remove();
      }
    });
    if (event.button !== 0) return;
    const bubble = event.target.closest?.('.msg-bubble');
    const control = event.target.closest?.('button, a, input, textarea, .message-actions');
    dragging = Boolean(bubble && !control);
    refresh();
  }, true);
  const release = () => { dragging = false; refresh(); };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  document.addEventListener('selectionchange', refresh);
}
