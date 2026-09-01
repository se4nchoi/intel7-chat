// ============================================================
// Pins Module: Pinned Message Drawer & Pinning Logic
// ============================================================

import { state } from './state.js';
import { formatTime, showToast } from './utils.js';

let activePinnedMessages = [];
let pinFetchSeq = 0;
let pinFetchAbortController = null;

export function getActivePinnedMessages() {
  return activePinnedMessages;
}

export async function fetchActivePinnedMessages(options = {}) {
  const { autoOpen = false, preserveOpen = false } = options;
  if (pinFetchAbortController) {
    pinFetchAbortController.abort();
    pinFetchAbortController = null;
  }
  const currentSeq = ++pinFetchSeq;
  const currentRoom = state.activeRoom;

  if (!currentRoom || !state.currentUser) {
    activePinnedMessages = [];
    updatePinnedUI({ autoOpen: false, preserveOpen: false });
    return;
  }

  pinFetchAbortController = new AbortController();
  try {
    const res = await fetch(`/api/conversations/${currentRoom.type}/${currentRoom.id}/pins`, {
      signal: pinFetchAbortController.signal,
    });
    if (currentSeq !== pinFetchSeq || state.activeRoom.id !== currentRoom.id) {
      return;
    }
    if (res.ok) {
      const data = await res.json();
      activePinnedMessages = Array.isArray(data.pins) ? data.pins : [];
    } else {
      activePinnedMessages = [];
    }
  } catch (err) {
    if (err.name === 'AbortError' || currentSeq !== pinFetchSeq || state.activeRoom.id !== currentRoom.id) {
      return;
    }
    activePinnedMessages = [];
  }
  if (currentSeq !== pinFetchSeq || state.activeRoom.id !== currentRoom.id) {
    return;
  }
  updatePinnedUI({ autoOpen, preserveOpen });
}

export function updatePinnedUI(options = {}) {
  const { autoOpen = false, preserveOpen = false } = options;
  const pinnedCountBadge = document.getElementById('pinned-count-badge');
  const pinnedDrawerCount = document.getElementById('pinned-drawer-count');
  const pinnedMessagesBtn = document.getElementById('pinned-messages-btn');
  const pinnedMessagesDrawer = document.getElementById('pinned-messages-drawer');

  const count = activePinnedMessages.length;
  if (pinnedCountBadge) {
    pinnedCountBadge.textContent = String(count);
    pinnedCountBadge.classList.toggle('hidden', count === 0);
  }
  if (pinnedDrawerCount) {
    pinnedDrawerCount.textContent = `${count}개`;
  }
  if (pinnedMessagesBtn) {
    pinnedMessagesBtn.classList.toggle('has-pins', count > 0);
  }
  if (pinnedMessagesDrawer) {
    if (count === 0) {
      pinnedMessagesDrawer.classList.add('hidden');
    } else if (autoOpen) {
      pinnedMessagesDrawer.classList.remove('hidden');
    }
  }
  renderPinnedDrawerList();
}

export function renderPinnedDrawerList() {
  const pinnedMessagesList = document.getElementById('pinned-messages-list');
  if (!pinnedMessagesList) return;
  pinnedMessagesList.replaceChildren();

  if (activePinnedMessages.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'pinned-empty';
    emptyEl.textContent = '고정된 메시지가 없습니다.';
    pinnedMessagesList.appendChild(emptyEl);
    return;
  }

  activePinnedMessages.forEach(pin => {
    const item = document.createElement('div');
    item.className = 'pinned-item';

    const metaRow = document.createElement('div');
    metaRow.className = 'pinned-item-meta';

    const authorSpan = document.createElement('strong');
    authorSpan.className = 'pinned-item-author';
    const authorNick = pin.message.nickname || pin.message.from_nick || '사용자';
    authorSpan.textContent = authorNick;
    metaRow.appendChild(authorSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'pinned-item-time';
    timeSpan.textContent = formatTime(pin.message.created_at || pin.pinned_at);
    metaRow.appendChild(timeSpan);

    const unpinBtn = document.createElement('button');
    unpinBtn.type = 'button';
    unpinBtn.className = 'pinned-item-unpin';
    unpinBtn.title = '고정 해제';
    unpinBtn.textContent = '✕';
    unpinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMessagePin(pin.message);
    });
    metaRow.appendChild(unpinBtn);

    item.appendChild(metaRow);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'pinned-item-content';
    contentDiv.textContent = pin.message.content || '(첨부파일)';
    item.appendChild(contentDiv);

    const footerDiv = document.createElement('div');
    footerDiv.className = 'pinned-item-footer';
    const pinnerName = pin.pinned_by?.display_name || pin.pinned_by?.username || '사용자';
    footerDiv.textContent = `📌 ${pinnerName}님이 고정함`;
    item.appendChild(footerDiv);

    item.addEventListener('click', () => {
      jumpToMessage(pin.message.message_id);
    });

    pinnedMessagesList.appendChild(item);
  });
}

export function jumpToMessage(formattedId) {
  if (!formattedId) return;
  const messageListEl = document.getElementById('message-list');
  const row = messageListEl?.querySelector(`.msg-row[data-message-id="${formattedId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('highlight-flash');
    void row.offsetWidth;
    row.classList.add('highlight-flash');
    setTimeout(() => row.classList.remove('highlight-flash'), 2000);
  } else {
    showToast('메시지가 현재 화면에 로드되지 않았습니다. (이전 메시지 더보기를 이용해주세요)', 'info');
  }
}

export async function toggleMessagePin(msg) {
  if (!msg || !state.currentUser) return;
  const rawId = typeof msg.message_id === 'string' ? msg.message_id.replace(/^(public|dm):/, '') : String(msg.id || '');
  const numId = Number(rawId);
  if (!numId) return;

  const convType = state.activeRoom.type;
  const convId = state.activeRoom.id;
  const currentlyPinned = Boolean(msg.is_pinned);

  try {
    if (currentlyPinned) {
      const res = await fetch(`/api/conversations/${convType}/${convId}/pins/${numId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '고정 해제에 실패했습니다.');
      }
      showToast('메시지 고정을 해제했습니다.', 'info');
    } else {
      const res = await fetch(`/api/conversations/${convType}/${convId}/pins/${numId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '메시지 고정에 실패했습니다.');
      }
      showToast('메시지를 고정했습니다.', 'success');
    }
  } catch (err) {
    showToast(err.message || '요청을 처리하지 못했습니다.', 'error');
  }
}

export function initPinsListeners() {
  const pinnedMessagesBtn = document.getElementById('pinned-messages-btn');
  const pinnedDrawerClose = document.getElementById('pinned-drawer-close');
  const pinnedMessagesDrawer = document.getElementById('pinned-messages-drawer');

  if (pinnedMessagesBtn && pinnedMessagesDrawer) {
    pinnedMessagesBtn.addEventListener('click', () => {
      pinnedMessagesDrawer.classList.toggle('hidden');
    });
  }
  if (pinnedDrawerClose && pinnedMessagesDrawer) {
    pinnedDrawerClose.addEventListener('click', () => {
      pinnedMessagesDrawer.classList.add('hidden');
    });
  }
}
