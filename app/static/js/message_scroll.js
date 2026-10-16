// Keep live traffic from moving a reader away from older messages.
let pending = 0;
const initialized = new WeakSet();

export function isNearLatest(list = document.getElementById('message-list')) {
  return !list || list.scrollHeight - list.clientHeight - list.scrollTop <= 80;
}

export function resetNewMessages() {
  pending = 0;
  document.getElementById('new-messages-btn')?.classList.add('hidden');
}

export function scrollToLatest() {
  const list = document.getElementById('message-list');
  if (list) list.scrollTop = list.scrollHeight;
  resetNewMessages();
}

export function initMessageScroll() {
  const list = document.getElementById('message-list');
  const button = document.getElementById('new-messages-btn');
  if (list && !initialized.has(list)) {
    initialized.add(list);
    list.addEventListener('scroll', () => { if (isNearLatest(list)) resetNewMessages(); }, { passive: true });
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
