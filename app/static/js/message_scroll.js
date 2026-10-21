// Keep live traffic from moving a reader away from older messages.
let pending = 0;
let wasNear = true;
const initialized = new WeakSet();

export function isNearLatest(list = document.getElementById('message-list')) {
  if (document.fullscreenElement?.id === 'ss-viewport') return false;
  return !list || list.scrollHeight - list.clientHeight - list.scrollTop <= 80;
}

export function resetNewMessages() {
  pending = 0;
  document.getElementById('new-messages-btn')?.classList.add('hidden');
}

export function scrollToLatest() {
  const list = document.getElementById('message-list');
  if (list) list.scrollTop = list.scrollHeight;
  wasNear = true;
  resetNewMessages();
}

export function initMessageScroll() {
  const list = document.getElementById('message-list');
  const button = document.getElementById('new-messages-btn');
  if (list && !initialized.has(list)) {
    initialized.add(list);
    wasNear = isNearLatest(list);
    list.addEventListener('scroll', () => {
      wasNear = isNearLatest(list);
      if (wasNear) resetNewMessages();
    }, { passive: true });

    list.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'IMG' && wasNear) {
        list.scrollTop = list.scrollHeight;
        resetNewMessages();
      }
    }, true);

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (wasNear) {
          list.scrollTop = list.scrollHeight;
          resetNewMessages();
        }
      }).observe(list);
    }
  }
  if (button && !initialized.has(button)) {
    initialized.add(button);
    button.addEventListener('click', scrollToLatest);
  }
}

export function appendWithScroll(append, { own = false, history = false } = {}) {
  const follow = isNearLatest() || (own && !history);
  append();
  if (follow) {
    scrollToLatest();
  } else if (!history) {
    const button = document.getElementById('new-messages-btn');
    pending++;
    if (button) {
      button.textContent = `↓ 새 메시지 ${pending}개 · 최신으로 이동`;
      button.classList.remove('hidden');
    }
  }
}
