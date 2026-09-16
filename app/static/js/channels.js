// ============================================================
// Channels Module: Channel Directory, Creation, Editing & Switching
// ============================================================

import { state, isConversationMuted } from './state.js';
import { makeKeyboardClickable, slugify, showToast } from './utils.js';
import { screenshareState } from './screenshare.js';

export const channelsDirectory = new Map();

export function getOrCreateChannel(chan) {
  const convId = 'channel:' + chan.id;
  const existing = state.channels.find(c => c.id === convId);
  if (!existing) {
    const newChan = {
      id: convId,
      type: 'channel',
      channelId: Number(chan.id),
      name: chan.name,
      displayName: chan.display_name,
      description: chan.description || '',
      isDefault: Boolean(chan.is_default),
      messages: [],
      messageIds: new Set(),
      unread: 0,
      hasOlder: false,
      loadingOlder: false,
      loaded: Number(chan.id) === 1,
      lastActivityTime: chan.created_at ? new Date(chan.created_at).getTime() : 0,
    };
    state.channels.push(newChan);
    channelsDirectory.set(Number(chan.id), chan);
    return newChan;
  } else {
    existing.displayName = chan.display_name;
    existing.description = chan.description || '';
    existing.name = chan.name;
    existing.isDefault = Boolean(chan.is_default);
    channelsDirectory.set(Number(chan.id), chan);
    return existing;
  }
}

export async function loadChannels(onSwitchConv) {
  if (!state.currentUser) return;
  try {
    const response = await fetch('/api/channels', { cache: 'no-store' });
    if (!response.ok) return;
    const channels = await response.json();
    if (Array.isArray(channels)) {
      channels.forEach(chan => {
        getOrCreateChannel(chan);
      });
      renderChannels(onSwitchConv);
    }
  } catch { /* ignore */ }
}

// ---- Channel Pin & Ordering Helpers ----
const SYSTEM_CHANNEL_IDS = [1, 2]; // general=1 fixed first, screenshare=2 fixed second

function getPinnedChannelIds() {
  if (!state.currentUser) return [];
  try {
    const raw = localStorage.getItem(`bamboo_pinned_channels_${state.currentUser.id}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePinnedChannelIds(ids) {
  if (!state.currentUser) return;
  localStorage.setItem(`bamboo_pinned_channels_${state.currentUser.id}`, JSON.stringify(ids));
}

function toggleChannelPin(channelId, onSwitchConv) {
  const pinned = getPinnedChannelIds();
  const idx = pinned.indexOf(channelId);
  if (idx === -1) { pinned.push(channelId); } else { pinned.splice(idx, 1); }
  savePinnedChannelIds(pinned);
  renderChannels(onSwitchConv);
}

export function updateChannelLastNotification(channelId) {
  const conv = state.channels.find(c => c.channelId === channelId);
  if (conv) { conv.lastNotificationTime = Date.now(); conv.lastActivityTime = Date.now(); }
}

export function renderChannels(onSwitchConv) {
  const channelListEl = document.getElementById('channel-list');
  if (!channelListEl) return;

  const pinnedIds = getPinnedChannelIds();
  const systemChannels = [];
  const pinnedChannels = [];
  const unpinnedChannels = [];

  for (const conv of state.channels) {
    if (SYSTEM_CHANNEL_IDS.includes(conv.channelId)) { systemChannels.push(conv); }
    else if (pinnedIds.includes(conv.channelId)) { pinnedChannels.push(conv); }
    else { unpinnedChannels.push(conv); }
  }

  systemChannels.sort((a, b) => SYSTEM_CHANNEL_IDS.indexOf(a.channelId) - SYSTEM_CHANNEL_IDS.indexOf(b.channelId));
  pinnedChannels.sort((a, b) => pinnedIds.indexOf(a.channelId) - pinnedIds.indexOf(b.channelId));
  unpinnedChannels.sort((a, b) => {
    const tA = a.lastNotificationTime || a.lastActivityTime || 0;
    const tB = b.lastNotificationTime || b.lastActivityTime || 0;
    return tB !== tA ? tB - tA : a.channelId - b.channelId;
  });

  const sorted = [...systemChannels, ...pinnedChannels, ...unpinnedChannels];
  channelListEl.replaceChildren();

  let dragSrcChannelId = null;

  sorted.forEach(conv => {
    const isActive = state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(conv.channelId);
    const isSystem = SYSTEM_CHANNEL_IDS.includes(conv.channelId);
    const isPinned = pinnedIds.includes(conv.channelId);

    const item = document.createElement('li');
    item.className = `sidebar-item conv-item channel-item${isActive ? ' active' : ''}`;
    item.dataset.id = conv.id;
    item.dataset.channelId = String(conv.channelId);

    if (!isSystem) {
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        dragSrcChannelId = conv.channelId;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        channelListEl.querySelectorAll('.channel-item').forEach(el => el.classList.remove('drag-over-above', 'drag-over-below'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const mid = item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
        channelListEl.querySelectorAll('.channel-item').forEach(el => el.classList.remove('drag-over-above', 'drag-over-below'));
        item.classList.add(e.clientY < mid ? 'drag-over-above' : 'drag-over-below');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over-above', 'drag-over-below'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over-above', 'drag-over-below');
        if (dragSrcChannelId === null || dragSrcChannelId === conv.channelId) return;
        if (SYSTEM_CHANNEL_IDS.includes(dragSrcChannelId)) return;

        const pinned = getPinnedChannelIds();
        if (!pinned.includes(dragSrcChannelId)) pinned.push(dragSrcChannelId);

        const srcIdx = pinned.indexOf(dragSrcChannelId);
        if (srcIdx !== -1) pinned.splice(srcIdx, 1);

        const dstIdx = pinned.indexOf(conv.channelId);
        const rect = item.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        if (dstIdx !== -1) {
          pinned.splice(insertBefore ? dstIdx : dstIdx + 1, 0, dragSrcChannelId);
        } else {
          pinned.push(dragSrcChannelId);
        }
        savePinnedChannelIds(pinned);
        dragSrcChannelId = null;
        renderChannels(onSwitchConv);
      });
    }

    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = '#';

    const name = document.createElement('span');
    name.className = 'sidebar-item-name conv-name';
    name.textContent = conv.displayName || conv.name;

    item.append(icon, name);

    if (isConversationMuted('channel', conv.channelId)) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'conv-mute-indicator';
      muteIcon.textContent = '🔕';
      muteIcon.title = '음소거됨';
      item.appendChild(muteIcon);
    }

    const unreadCount = state.unreadCounts.channels[conv.channelId] ?? conv.unread ?? 0;
    if (unreadCount > 0 && !isActive) {
      const badge = document.createElement('span');
      badge.className = 'sidebar-badge conv-unread';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      item.appendChild(badge);
    }

    if (screenshareState.hasSession(conv.channelId)) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'channel-live-badge';
      liveBadge.innerHTML = '<span class="live-pulse-dot"></span>LIVE';
      liveBadge.title = '실시간 화면 공유 방송 중';
      item.appendChild(liveBadge);
    }

    if (!isSystem) {
      const pinBtn = document.createElement('button');
      pinBtn.className = `channel-pin-btn${isPinned ? ' is-pinned' : ''}`;
      pinBtn.textContent = '📌';
      pinBtn.title = isPinned ? '고정 해제' : '채널 고정';
      pinBtn.setAttribute('aria-label', isPinned ? '고정 해제' : '채널 고정');
      pinBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleChannelPin(conv.channelId, onSwitchConv); });
      item.appendChild(pinBtn);
    }

    const activate = () => onSwitchConv('channel', conv.channelId);
    item.addEventListener('click', (e) => { if (!e.target.classList.contains('channel-pin-btn')) activate(); });
    makeKeyboardClickable(item, activate);
    channelListEl.appendChild(item);
  });
}

export function openChannelModal() {
  const channelForm = document.getElementById('channel-form');
  const channelNameInput = document.getElementById('channel-name-input');
  const channelDisplayInput = document.getElementById('channel-display-input');
  const channelError = document.getElementById('channel-error');
  const channelSubmit = document.getElementById('channel-submit');
  const channelModal = document.getElementById('channel-modal');

  if (channelForm) channelForm.reset();
  if (channelNameInput) delete channelNameInput.dataset.manualEdit;
  if (channelError) channelError.textContent = '';
  if (channelSubmit) channelSubmit.disabled = false;
  if (channelModal) channelModal.classList.remove('hidden');
  channelDisplayInput?.focus();
}

export function closeChannelModal() {
  const channelModal = document.getElementById('channel-modal');
  if (channelModal) channelModal.classList.add('hidden');
}

export function openChannelEditModal(chan) {
  const channelEditModal = document.getElementById('channel-edit-modal');
  const channelEditId = document.getElementById('channel-edit-id');
  const channelEditDisplayInput = document.getElementById('channel-edit-display-input');
  const channelEditNameInput = document.getElementById('channel-edit-name-input');
  const channelEditDescInput = document.getElementById('channel-edit-desc-input');
  const channelEditError = document.getElementById('channel-edit-error');
  const channelEditSubmit = document.getElementById('channel-edit-submit');
  const channelArchiveBtn = document.getElementById('channel-archive-btn');
  const channelDeleteBtn = document.getElementById('channel-delete-btn');

  if (!chan || !channelEditModal) return;
  if (channelEditId) channelEditId.value = String(chan.id);
  if (channelEditDisplayInput) channelEditDisplayInput.value = chan.display_name || '';
  if (channelEditNameInput) channelEditNameInput.value = chan.name || '';
  if (channelEditDescInput) channelEditDescInput.value = chan.description || '';
  if (channelEditError) channelEditError.textContent = '';
  if (channelEditSubmit) channelEditSubmit.disabled = false;

  const isDefault = Boolean(chan.is_default) || Number(chan.id) === 1;
  if (channelArchiveBtn) {
    channelArchiveBtn.classList.toggle('hidden', isDefault);
    channelArchiveBtn.disabled = false;
  }
  if (channelDeleteBtn) {
    channelDeleteBtn.classList.toggle('hidden', isDefault);
    channelDeleteBtn.disabled = false;
  }
  channelEditModal.classList.remove('hidden');
  channelEditDisplayInput?.focus();
}

export function closeChannelEditModal() {
  const channelEditModal = document.getElementById('channel-edit-modal');
  if (channelEditModal) channelEditModal.classList.add('hidden');
}

export function initChannelsListeners(onSwitchConv) {
  const createChannelBtn = document.getElementById('create-channel-btn');
  const channelModalClose = document.getElementById('channel-modal-close');
  const channelModal = document.getElementById('channel-modal');
  const channelDisplayInput = document.getElementById('channel-display-input');
  const channelNameInput = document.getElementById('channel-name-input');
  const channelDescInput = document.getElementById('channel-desc-input');
  const channelForm = document.getElementById('channel-form');
  const channelSubmit = document.getElementById('channel-submit');
  const channelError = document.getElementById('channel-error');
  const channelSettingsBtn = document.getElementById('channel-settings-btn');
  const channelEditModalClose = document.getElementById('channel-edit-modal-close');
  const channelEditModal = document.getElementById('channel-edit-modal');
  const channelEditForm = document.getElementById('channel-edit-form');
  const channelArchiveBtn = document.getElementById('channel-archive-btn');
  const channelDeleteBtn = document.getElementById('channel-delete-btn');

  if (createChannelBtn) createChannelBtn.addEventListener('click', openChannelModal);
  if (channelModalClose) channelModalClose.addEventListener('click', closeChannelModal);
  if (channelModal) {
    channelModal.addEventListener('click', event => {
      if (event.target === channelModal) closeChannelModal();
    });
  }

  if (channelDisplayInput) {
    channelDisplayInput.addEventListener('input', () => {
      if (!channelNameInput?.dataset.manualEdit) {
        if (channelNameInput) channelNameInput.value = slugify(channelDisplayInput.value);
      }
    });
  }
  if (channelNameInput) {
    channelNameInput.addEventListener('input', () => {
      channelNameInput.dataset.manualEdit = channelNameInput.value ? 'true' : '';
    });
  }

  if (channelForm) {
    channelForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (channelError) channelError.textContent = '';
      if (channelSubmit) channelSubmit.disabled = true;
      const name = channelNameInput?.value.trim();
      const displayName = channelDisplayInput?.value.trim();
      const description = channelDescInput?.value.trim();
      try {
        const response = await fetch('/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, display_name: displayName, description }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || '채널을 만들지 못했습니다.');
        getOrCreateChannel(data);
        closeChannelModal();
        renderChannels(onSwitchConv);
        onSwitchConv('channel', data.id);
        showToast(`#${data.display_name} 채널을 만들었습니다.`, 'success');
      } catch (err) {
        if (channelError) channelError.textContent = err.message || '채널을 만들지 못했습니다.';
      } finally {
        if (channelSubmit) channelSubmit.disabled = false;
      }
    });
  }

  if (channelSettingsBtn) {
    channelSettingsBtn.addEventListener('click', () => {
      if (state.activeRoom.type === 'channel') {
        const chanObj = channelsDirectory.get(Number(state.activeRoom.id));
        if (chanObj) openChannelEditModal(chanObj);
      }
    });
  }

  if (channelEditModalClose) channelEditModalClose.addEventListener('click', closeChannelEditModal);
  if (channelEditModal) {
    channelEditModal.addEventListener('click', event => {
      if (event.target === channelEditModal) closeChannelEditModal();
    });
  }

  if (channelEditForm) {
    channelEditForm.addEventListener('submit', async event => {
      event.preventDefault();
      const channelEditId = document.getElementById('channel-edit-id');
      const channelEditNameInput = document.getElementById('channel-edit-name-input');
      const channelEditDisplayInput = document.getElementById('channel-edit-display-input');
      const channelEditDescInput = document.getElementById('channel-edit-desc-input');
      const channelEditError = document.getElementById('channel-edit-error');
      const channelEditSubmit = document.getElementById('channel-edit-submit');

      if (channelEditError) channelEditError.textContent = '';
      if (channelEditSubmit) channelEditSubmit.disabled = true;
      const chanId = Number(channelEditId?.value);
      const name = channelEditNameInput?.value.trim();
      const displayName = channelEditDisplayInput?.value.trim();
      const description = channelEditDescInput?.value.trim();
      try {
        const response = await fetch(`/api/channels/${chanId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, display_name: displayName, description }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || '채널 정보를 수정하지 못했습니다.');
        getOrCreateChannel(data);
        closeChannelEditModal();
        renderChannels(onSwitchConv);
        showToast(`#${data.display_name} 채널 정보가 수정되었습니다.`, 'success');
      } catch (err) {
        if (channelEditError) channelEditError.textContent = err.message || '채널 정보를 수정하지 못했습니다.';
      } finally {
        if (channelEditSubmit) channelEditSubmit.disabled = false;
      }
    });
  }

  if (channelArchiveBtn) {
    channelArchiveBtn.addEventListener('click', async () => {
      const channelEditId = document.getElementById('channel-edit-id');
      const chanId = Number(channelEditId?.value);
      if (!chanId || chanId === 1) return;
      const chan = channelsDirectory.get(chanId);
      const displayName = chan?.display_name || `채널 ${chanId}`;
      if (!confirm(`'# ${displayName}' 채널을 보관하시겠습니까?\n채널 목록에서 숨겨지며 기존 대화 기록과 첨부파일은 안전하게 보존됩니다.`)) {
        return;
      }
      try {
        const response = await fetch(`/api/channels/${chanId}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unarchive: false }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || '채널을 보관하지 못했습니다.');
        state.channels = state.channels.filter(c => c.channelId !== chanId);
        channelsDirectory.delete(chanId);
        closeChannelEditModal();
        renderChannels(onSwitchConv);
        onSwitchConv('channel', 1);
        showToast(`#${displayName} 채널이 보관되었습니다.`, 'info');
      } catch (err) {
        showToast(err.message || '채널을 보관하지 못했습니다.', 'error');
      }
    });
  }

  if (channelDeleteBtn) {
    channelDeleteBtn.addEventListener('click', async () => {
      const channelEditId = document.getElementById('channel-edit-id');
      const chanId = Number(channelEditId?.value);
      if (!chanId || chanId === 1) return;
      const chan = channelsDirectory.get(chanId);
      const displayName = chan?.display_name || `채널 ${chanId}`;
      if (!confirm(`'# ${displayName}' 채널을 정말로 영구 삭제하시겠습니까?\n채널 내 모든 대화 및 첨부파일이 완전히 삭제되며 복구할 수 없습니다.`)) {
        return;
      }
      try {
        const response = await fetch(`/api/channels/${chanId}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || '채널을 삭제하지 못했습니다.');
        state.channels = state.channels.filter(c => c.channelId !== chanId);
        channelsDirectory.delete(chanId);
        closeChannelEditModal();
        renderChannels(onSwitchConv);
        onSwitchConv('channel', 1);
        showToast(`#${displayName} 채널이 영구 삭제되었습니다.`, 'info');
      } catch (err) {
        showToast(err.message || '채널을 삭제하지 못했습니다.', 'error');
      }
    });
  }
}
