import { state } from './state.js';
import { formatTime, showToast } from './utils.js';

let searchHintTimer = null;

export function showSearchHint() {
  const popover = document.getElementById('search-hint-popover');
  if (!popover || !state.currentUser) return;
  if (searchHintTimer) clearTimeout(searchHintTimer);
  popover.classList.remove('hidden');
  searchHintTimer = setTimeout(() => popover.classList.add('hidden'), 7000);
}

function renderResults(results, onSwitchConversation) {
  const container = document.getElementById('message-search-results');
  if (!container) return;
  container.replaceChildren();
  results.forEach(result => {
    const item = document.createElement('div');
    item.className = 'message-search-result';
    item.tabIndex = 0;

    const head = document.createElement('div');
    head.className = 'message-search-result-head';
    const location = document.createElement('span');
    location.textContent = `${result.message_type === 'channel' ? '#' : '💬 '} ${result.conversation_name} · ${result.author}`;
    const time = document.createElement('span');
    time.textContent = formatTime(result.created_at);
    head.append(location, time);

    const body = document.createElement('div');
    body.className = 'message-search-result-body';
    body.textContent = result.content || '(파일 첨부)';
    item.append(head, body);

    const attachments = Array.isArray(result.attachments) ? result.attachments.filter(file => !file.removed) : [];
    if (attachments.length) {
      const files = document.createElement('div');
      files.className = 'message-search-files';
      attachments.forEach(file => {
        const link = document.createElement('a');
        link.className = 'message-search-file';
        link.href = file.url;
        link.textContent = `📎 ${file.name}`;
        link.addEventListener('click', event => event.stopPropagation());
        files.appendChild(link);
      });
      item.appendChild(files);
    }

    const open = () => onSwitchConversation(result.message_type, result.conversation_id);
    item.addEventListener('click', open);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    container.appendChild(item);
  });
}

export function initSearchListeners(onSwitchConversation) {
  const button = document.getElementById('message-search-btn');
  const drawer = document.getElementById('message-search-drawer');
  const close = document.getElementById('message-search-close');
  const form = document.getElementById('message-search-form');
  const input = document.getElementById('message-search-input');
  const scope = document.getElementById('message-search-scope');
  const status = document.getElementById('message-search-status');
  const results = document.getElementById('message-search-results');
  const hint = document.getElementById('search-hint-popover');
  const hintClose = document.getElementById('search-hint-close');

  button?.addEventListener('click', () => {
    hint?.classList.add('hidden');
    drawer?.classList.toggle('hidden');
    if (!drawer?.classList.contains('hidden')) input?.focus();
  });
  hintClose?.addEventListener('click', event => {
    event.stopPropagation();
    hint?.classList.add('hidden');
    if (searchHintTimer) clearTimeout(searchHintTimer);
  });
  close?.addEventListener('click', () => drawer?.classList.add('hidden'));
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input?.value.trim() || '';
    if (query.length < 2) {
      if (status) status.textContent = '두 글자 이상 입력하세요.';
      return;
    }
    const searchScope = scope?.value === 'global' ? 'global' : 'current';
    const params = new URLSearchParams({ q: query, scope: searchScope });
    if (searchScope === 'current') {
      params.set('conversation_type', state.activeRoom.type);
      params.set('conversation_id', state.activeRoom.id);
    }
    if (status) status.textContent = '검색 중…';
    results?.replaceChildren();
    try {
      const response = await fetch(`/api/search?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '검색하지 못했습니다.');
      const items = Array.isArray(data.results) ? data.results : [];
      if (status) status.textContent = items.length ? `${items.length}개 결과` : '검색 결과가 없습니다.';
      renderResults(items, onSwitchConversation);
    } catch (error) {
      if (status) status.textContent = error.message || '검색하지 못했습니다.';
      showToast(error.message || '검색하지 못했습니다.', 'error');
    }
  });
}
