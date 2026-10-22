// ============================================================
// Classroom Chat — Master Javascript Entrypoint
// Native ES Module Architecture
// ============================================================

import { state, setCurrentUser, setActiveRoom } from './state.js';
import { showToast } from './utils.js';
import { initAuthListeners, bootstrapAuth, updateNickBadge, showNicknameHint, refreshStorageWarning, showAuthModal } from './auth.js';
import { loadChannels, renderChannels, initChannelsListeners, channelsDirectory } from './channels.js';
import { renderDms, displayNickname, getOrCreateDm, userDirectory, loadGroupDms, loadCandidateUsers } from './dm.js';
import {
  loadDrafts,
  saveCurrentDraft,
  clearCurrentDraft,
  loadActiveDraft,
  resizeComposer,
  updateCharCount,
  renderComposerPreviews,
  renderMessages,
  appendMessageNode,
  updateMessageInDOM,
  updateMessageHiddenInDOM,
  removeMessageFromDOM,
  applyAttachmentDeletedInDOM,
  initChatListeners,
  replyTargets,
  pendingAttachments,
  clearAllPendingAttachments,
  initReplyReturnButton,
  hideReplyReturnButton,
} from './chat.js';
import { initWebSocket, sendWebSocketMessage, applyServerUnreadCounts } from './ws.js';
import { isNearLatest, scrollToLatest } from './message_scroll.js';
import { initSearchListeners, showSearchHint } from './search.js';
import { fetchActivePinnedMessages, initPinsListeners } from './pins.js';
import {
  initQuizListeners,
  refreshQuizHeaderStreak,
  refreshQuizSidebarCounts,
  handleLeaderboardInvalidated,
} from './quiz.js';
import { initPlayHubListeners } from './play_hub.js';
import { initScreenShareUI, handleConversationSwitch, handleChannelSwitch, resetScreenShare, loadScreenshares } from './screenshare.js';
import { initMessageScroll } from './message_scroll.js';
import {
  openGlobalNotificationModal,
  closeGlobalNotificationModal,
  openConvNotificationModal,
  closeConvNotificationModal,
  updateConversationNotificationUI,
  updateGlobalNotificationUI,
  setSnooze,
  clearSnooze,
  checkDesktopNotificationContext,
  setDesktopNotificationEnabled,
  isDesktopNotificationEnabled,
  isChatActiveAndFocused,
} from './notifications.js';
import { playNotificationSound, setSoundMode, setSoundVolume } from './audio.js';

const OPTIONAL_GAME_MODULES = [
  { name: '체스', path: './chess.js', initializer: 'initChessListeners' },
  { name: '장기', path: './janggi.js', initializer: 'initJanggiListeners' },
  { name: '오목', path: './omok.js', initializer: 'initOmokListeners' },
  { name: '오셀로', path: './othello.js', initializer: 'initOthelloListeners' },
];

async function initOptionalGameModules() {
  await Promise.allSettled(OPTIONAL_GAME_MODULES.map(async ({ name, path, initializer }) => {
    try {
      const module = await import(path);
      const init = module[initializer];
      if (typeof init !== 'function') {
        throw new TypeError(`${initializer} export is missing`);
      }
      init();
    } catch (error) {
      console.error(`[BambooChat] ${name} module failed to initialize`, error);
      showToast(`${name} 기능을 불러오지 못했습니다. 채팅과 로그인은 계속 사용할 수 있습니다.`, 'error');
    }
  }));
}

function syncTouchableViewport() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  if (viewportHeight > 0) {
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
  }
}

function initTouchableViewport() {
  syncTouchableViewport();
  window.addEventListener('resize', syncTouchableViewport, { passive: true });
  window.addEventListener('orientationchange', syncTouchableViewport, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncTouchableViewport, { passive: true });
    window.visualViewport.addEventListener('scroll', syncTouchableViewport, { passive: true });
  }
}


// --- Room Switching ---
function clearConversationUnreadOptimistic(type, id) {
  if (type === 'channel') {
    state.unreadCounts.channels[id] = 0;
    const chan = state.channels?.find?.(c => String(c.id) === String(id));
    if (chan) chan.unread = 0;
  } else if (type === 'dm') {
    state.unreadCounts.dms[id] = 0;
    const u = userDirectory.get(id);
    if (u) state.unreadCounts.dms[String(u.id)] = 0;
    const dmObj = state.dms?.find?.(d => d.name === id);
    if (dmObj) {
      dmObj.unread = 0;
      if (dmObj.partnerUserId) state.unreadCounts.dms[String(dmObj.partnerUserId)] = 0;
    }
  }
}

const acknowledgedMessageIds = new Map();

async function acknowledgeConversation(type, id, lastReadMessageId) {
  const numericId = Number(String(lastReadMessageId || '').replace(/^(public|dm):/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) return;

  // Do not let a slow history request acknowledge a room the user already left.
  if (state.activeRoom.type !== type || String(state.activeRoom.id) !== String(id)) return;

  const convKey = `${type}:${id}`;
  const currentAcked = acknowledgedMessageIds.get(convKey) || 0;
  if (numericId <= currentAcked) return;
  acknowledgedMessageIds.set(convKey, numericId);

  clearConversationUnreadOptimistic(type, id);
  renderChannels(switchConversation);
  renderDms(switchConversation);

  try {
    const res = await fetch('/api/read-states/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_type: type,
        conversation_id: id,
        last_read_message_id: numericId,
      }),
    });
    if (!res.ok) throw new Error(`ACK failed with status ${res.status}`);
    const data = await res.json().catch(() => null);
    if (data?.unread_counts) {
      applyServerUnreadCounts(data.unread_counts);
      renderChannels(switchConversation);
      renderDms(switchConversation);
    }
  } catch (err) {
    console.warn('Failed to acknowledge conversation read state.', err);
  }
}

function checkAndAckActiveConversation() {
  if (!isChatActiveAndFocused() || !state.activeRoom.id || !isNearLatest()) return;
  const msgList = document.getElementById('message-list');
  if (!msgList) return;
  const msgRows = msgList.querySelectorAll('.msg-row[data-message-id]');
  if (msgRows.length === 0) return;
  const lastRow = msgRows[msgRows.length - 1];
  const lastId = lastRow.dataset.messageId;
  if (lastId) {
    acknowledgeConversation(state.activeRoom.type, state.activeRoom.id, lastId);
  }
}

window.addEventListener('focus', checkAndAckActiveConversation);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkAndAckActiveConversation();
});

async function switchConversation(type, id) {
  saveCurrentDraft();
  setActiveRoom(type, id);
  clearConversationUnreadOptimistic(type, id);

  const chatAreaTitle = document.getElementById('chat-area-title');
  const chatAreaDesc = document.getElementById('chat-area-desc');
  const msgInput = document.getElementById('msg-input');
  const channelSettingsBtn = document.getElementById('channel-settings-btn');
  const groupDmManageBtn = document.getElementById('group-dm-manage-btn');
  const screenshareToggleBtn = document.getElementById('screenshare-toggle-btn');
  const loadOlderBtn = document.getElementById('load-older-btn');

  if (type === 'channel') {
    const chanId = Number(id);
    const groupDm = state.groupDms?.find(g => Number(g.id) === chanId);
    if (groupDm) {
      const displayName = groupDm.effective_name || groupDm.display_name || '그룹 대화';
      const memberNames = (groupDm.members || []).map(m => m.display_name || m.username).join(', ');
      if (chatAreaTitle) chatAreaTitle.textContent = `👥 ${displayName}`;
      if (chatAreaDesc) chatAreaDesc.textContent = `참여자 ${groupDm.member_count || groupDm.members?.length || 0}명: ${memberNames}`;
      if (msgInput) msgInput.placeholder = `${displayName}에 메시지 입력`;
      if (channelSettingsBtn) channelSettingsBtn.classList.add('hidden');
      if (groupDmManageBtn) groupDmManageBtn.classList.remove('hidden');
      if (screenshareToggleBtn) screenshareToggleBtn.classList.add('hidden');
    } else {
      const chanObj = channelsDirectory.get(chanId);
      const displayName = chanObj?.display_name || (chanId === 1 ? '전체 채팅' : `채널 ${chanId}`);
      if (chatAreaTitle) chatAreaTitle.textContent = `# ${displayName}`;
      if (chatAreaDesc) chatAreaDesc.textContent = chanObj?.description || '';
      if (msgInput) msgInput.placeholder = `# ${displayName}에 메시지 입력`;
      if (channelSettingsBtn) {
        channelSettingsBtn.classList.toggle('hidden', state.currentUser?.role !== 'admin');
      }
      if (groupDmManageBtn) groupDmManageBtn.classList.add('hidden');
      if (screenshareToggleBtn) screenshareToggleBtn.classList.remove('hidden');
    }
  } else {
    const displayName = displayNickname(String(id));
    if (chatAreaTitle) chatAreaTitle.textContent = `💬 ${displayName}`;
    if (chatAreaDesc) chatAreaDesc.textContent = '';
    if (msgInput) msgInput.placeholder = `${displayName}에게 DM 보내기`;
    if (channelSettingsBtn) channelSettingsBtn.classList.add('hidden');
    if (groupDmManageBtn) groupDmManageBtn.classList.add('hidden');
    if (screenshareToggleBtn) screenshareToggleBtn.classList.remove('hidden');
  }

  loadActiveDraft();
  renderComposerPreviews();
  updateConversationNotificationUI();
  handleConversationSwitch(type, id);
  renderChannels(switchConversation);
  renderDms(switchConversation);

  // Fetch conversation messages
  try {
    const endpoint = type === 'channel'
      ? (String(id) === '1' ? `/api/history/public` : `/api/channels/${id}/messages`)
      : `/api/history/dm/${encodeURIComponent(id)}`;
    const res = await fetch(endpoint, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (state.activeRoom.type !== type || String(state.activeRoom.id) !== String(id)) return;
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      const messages = rawMessages.map(m => ({
        ...m,
        msgType: type === 'channel' ? 'chat' : 'dm'
      }));
      activeHasMore = Boolean(data.has_more);
      if (loadOlderBtn) {
        loadOlderBtn.classList.toggle('hidden', !data.has_more);
      }
      renderMessages(messages);
      scrollToLatest();
      requestAnimationFrame(() => scrollToLatest());
      setTimeout(() => scrollToLatest(), 60);

      const newestMessage = rawMessages.reduce((latest, message) => {
        const messageId = Number(String(message.message_id || '').replace(/^(public|dm):/, ''));
        return Number.isInteger(messageId) && messageId > latest ? messageId : latest;
      }, 0);
      if (newestMessage) acknowledgeConversation(type, id, newestMessage);
    }
  } catch { /* ignore */ }



  fetchActivePinnedMessages({ autoOpen: false });
  hideReplyReturnButton();

  // Close mobile sidebar if open
  const sidebar = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  if (sidebar && sidebar.classList.contains('open')) {
    sidebar.classList.remove('open');
    if (sidebarBackdrop) sidebarBackdrop.classList.add('hidden');
  }

  msgInput?.focus();
}

// --- Outbound Message Sender ---
function handleSendMessage() {
  const msgInput = document.getElementById('msg-input');
  if (!msgInput) return;
  const content = msgInput.value.trim();
  const currentKey = `${state.activeRoom.type}:${state.activeRoom.id}`;
  const states = pendingAttachments.get(currentKey) || [];

  if (states.some(st => ['queued', 'uploading'].includes(st.status))) {
    showToast('모든 파일 업로드가 끝날 때까지 기다려 주세요.', 'warning');
    return;
  }
  if (states.some(st => st.status === 'error')) {
    showToast('실패한 첨부 파일을 제거해 주세요.', 'error');
    return;
  }

  const readyAttachments = states.filter(st => st.status === 'ready' && st.meta);
  if (!content && readyAttachments.length === 0) return;

  const payload = {
    type: state.activeRoom.type === 'dm' ? 'dm' : 'chat',
    content,
  };
  if (state.activeRoom.type === 'dm') {
    payload.to = state.activeRoom.id;
  } else {
    payload.channel_id = Number(state.activeRoom.id);
  }
  if (readyAttachments.length) {
    payload.attachment_ids = readyAttachments.map(st => st.meta.id);
  }
  const reply = replyTargets.get(currentKey);
  if (reply) payload.reply = reply;

  const sent = sendWebSocketMessage(payload);
  if (sent) {
    msgInput.value = '';
    clearCurrentDraft(currentKey);
    replyTargets.delete(currentKey);
    clearAllPendingAttachments(currentKey);
    resizeComposer();
    updateCharCount();
    msgInput.focus();
  }
}

// --- Load Older Messages ---
let loadingOlder = false;
let activeHasMore = false;

async function loadOlderMessages() {
  if (loadingOlder || !activeHasMore) return;
  const messageListEl = document.getElementById('message-list');
  const loadOlderBtn = document.getElementById('load-older-btn');
  const firstRow = messageListEl?.querySelector('.msg-row[data-message-id]');
  const firstId = firstRow?.dataset?.messageId;
  if (!firstId) return;

  // Extract numeric id
  const numericId = firstId.includes(':') ? firstId.split(':')[1] : firstId;
  if (!numericId) return;

  loadingOlder = true;
  if (loadOlderBtn) { loadOlderBtn.disabled = true; loadOlderBtn.textContent = '불러오는 중...'; }

  try {
    const { type, id } = state.activeRoom;
    const basePath = type === 'channel'
      ? (String(id) === '1' ? `/api/history/public` : `/api/channels/${id}/messages`)
      : `/api/history/dm/${encodeURIComponent(id)}`;
    const res = await fetch(`${basePath}?before_id=${numericId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const rawMessages = Array.isArray(data.messages) ? data.messages : [];
    const messages = rawMessages.map(m => ({ ...m, msgType: type === 'channel' ? 'chat' : 'dm' }));

    if (messages.length && messageListEl) {
      const prevHeight = messageListEl.scrollHeight;
      const prevTop = messageListEl.scrollTop;
      // Prepend older messages before the first existing .msg-row
      const loadOlderBtnEl = messageListEl.querySelector('#load-older-btn');
      const insertAnchor = messageListEl.querySelector('.msg-row') || null;
      // Render from oldest to newest at the top
      const frag = document.createDocumentFragment();
      const tempDiv = document.createElement('div');
      messages.forEach(msg => appendMessageNode(msg, null)); // appended temporarily
      // They got appended at end, so move them to before insertAnchor
      const newRows = [...messageListEl.querySelectorAll('.msg-row')]
        .slice(-(messages.length));
      newRows.reverse().forEach(row => {
        messageListEl.insertBefore(row, insertAnchor);
      });
      messageListEl.scrollTop = prevTop + (messageListEl.scrollHeight - prevHeight);
    }

    activeHasMore = Boolean(data.has_more);
    if (loadOlderBtn) loadOlderBtn.classList.toggle('hidden', !activeHasMore);
  } catch {
    showToast('이전 메시지를 불러오지 못했습니다.', 'error');
  } finally {
    loadingOlder = false;
    if (loadOlderBtn) { loadOlderBtn.disabled = false; loadOlderBtn.textContent = '↑ 이전 메시지 더 불러오기'; }
  }
}

// --- Group DM Modal Interactions ---
function initGroupDmModals(onSwitchConv) {
  // 1. Create Group DM Modal
  const createModal = document.getElementById('create-group-dm-modal');
  const createBtn = document.getElementById('create-group-dm-btn');
  const createClose = document.getElementById('create-group-dm-close');
  const createForm = document.getElementById('create-group-dm-form');
  const nameInput = document.getElementById('group-dm-name-input');
  const searchInput = document.getElementById('group-dm-user-search');
  const userListEl = document.getElementById('group-dm-user-list');
  const countBadge = document.getElementById('group-dm-selected-count');
  const submitBtn = document.getElementById('create-group-dm-submit');
  const errorEl = document.getElementById('create-group-dm-error');

  const selectedUserIds = new Set();
  let candidateUsers = [];

  function updateSelectedCount() {
    const count = selectedUserIds.size;
    if (countBadge) countBadge.textContent = `${count}명 선택됨`;
    if (submitBtn) submitBtn.disabled = count === 0;
  }

  function renderPickerUsers(filterQuery = '') {
    if (!userListEl) return;
    userListEl.replaceChildren();
    const query = filterQuery.trim().toLowerCase();
    const filtered = candidateUsers.filter(u => {
      if (!query) return true;
      return (u.display_name || '').toLowerCase().includes(query) ||
             (u.username || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'group-dm-empty-msg';
      empty.textContent = query ? '일치하는 사용자가 없습니다.' : '초대 가능한 사용자가 없습니다.';
      userListEl.appendChild(empty);
      return;
    }

    filtered.forEach(u => {
      const row = document.createElement('label');
      row.className = 'group-dm-picker-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = u.id;
      cb.checked = selectedUserIds.has(Number(u.id));
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedUserIds.add(Number(u.id));
        } else {
          selectedUserIds.delete(Number(u.id));
        }
        updateSelectedCount();
      });

      const dot = document.createElement('span');
      dot.className = `online-dot${u.online ? '' : ' offline'}`;

      const nameWrap = document.createElement('span');
      nameWrap.className = 'group-dm-picker-names';

      const displayName = document.createElement('span');
      displayName.className = 'group-dm-picker-display';
      displayName.textContent = u.display_name || u.username;

      const username = document.createElement('span');
      username.className = 'group-dm-picker-username';
      username.textContent = `@${u.username}`;

      nameWrap.append(displayName, username);
      row.append(cb, dot, nameWrap);
      userListEl.appendChild(row);
    });
  }

  async function openCreateModal() {
    if (!createModal) return;
    selectedUserIds.clear();
    if (nameInput) nameInput.value = '';
    if (searchInput) searchInput.value = '';
    if (errorEl) errorEl.textContent = '';
    updateSelectedCount();

    createModal.classList.remove('hidden');
    if (userListEl) {
      userListEl.innerHTML = '<div class="group-dm-loading">사용자 목록을 불러오는 중...</div>';
    }

    try {
      candidateUsers = await loadCandidateUsers();
      renderPickerUsers();
    } catch {
      if (userListEl) userListEl.innerHTML = '<div class="group-dm-empty-msg">사용자 목록을 불러오지 못했습니다.</div>';
    }
  }

  function closeCreateModal() {
    createModal?.classList.add('hidden');
  }

  createBtn?.addEventListener('click', openCreateModal);
  createClose?.addEventListener('click', closeCreateModal);
  createModal?.addEventListener('click', (e) => {
    if (e.target === createModal) closeCreateModal();
  });

  searchInput?.addEventListener('input', () => {
    renderPickerUsers(searchInput.value);
  });

  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedUserIds.size === 0) return;
    if (errorEl) errorEl.textContent = '';
    if (submitBtn) submitBtn.disabled = true;

    try {
      const res = await fetch('/api/group-dms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_ids: Array.from(selectedUserIds),
          name: nameInput?.value.trim() || null,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.detail || '그룹 대화 생성에 실패했습니다.');
      }

      const created = await res.json();
      closeCreateModal();
      showToast('새 그룹 대화가 시작되었습니다.', 'success');
      await loadGroupDms(onSwitchConv);
      onSwitchConv('channel', created.id);
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // 2. Manage Group DM Modal
  const manageModal = document.getElementById('manage-group-dm-modal');
  const manageBtn = document.getElementById('group-dm-manage-btn');
  const manageClose = document.getElementById('manage-group-dm-close');
  const manageNameForm = document.getElementById('manage-group-dm-name-form');
  const manageNameInput = document.getElementById('manage-group-dm-name-input');
  const manageNameSave = document.getElementById('manage-group-dm-name-save');
  const memberCountSpan = document.getElementById('manage-group-dm-member-count');
  const membersListEl = document.getElementById('manage-group-dm-members-list');
  const inviteSearchInput = document.getElementById('manage-group-dm-invite-search');
  const inviteListEl = document.getElementById('manage-group-dm-invite-list');
  const inviteCountSpan = document.getElementById('manage-group-dm-invite-count');
  const inviteSubmitBtn = document.getElementById('manage-group-dm-invite-btn');
  const manageErrorEl = document.getElementById('manage-group-dm-error');
  const leaveBtn = document.getElementById('manage-group-dm-leave-btn');

  let currentManageGdmId = null;
  const selectedInviteIds = new Set();
  let availableInviteUsers = [];

  function updateInviteCount() {
    const count = selectedInviteIds.size;
    if (inviteCountSpan) inviteCountSpan.textContent = `${count}명 선택됨`;
    if (inviteSubmitBtn) inviteSubmitBtn.disabled = count === 0;
  }

  function renderInvitePicker(filterQuery = '') {
    if (!inviteListEl) return;
    inviteListEl.replaceChildren();
    const query = filterQuery.trim().toLowerCase();
    const filtered = availableInviteUsers.filter(u => {
      if (!query) return true;
      return (u.display_name || '').toLowerCase().includes(query) ||
             (u.username || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'group-dm-empty-msg';
      empty.textContent = query ? '일치하는 사용자가 없습니다.' : '초대 가능한 모든 사용자가 이미 참여 중입니다.';
      inviteListEl.appendChild(empty);
      return;
    }

    filtered.forEach(u => {
      const row = document.createElement('label');
      row.className = 'group-dm-picker-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = u.id;
      cb.checked = selectedInviteIds.has(Number(u.id));
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedInviteIds.add(Number(u.id));
        } else {
          selectedInviteIds.delete(Number(u.id));
        }
        updateInviteCount();
      });

      const dot = document.createElement('span');
      dot.className = `online-dot${u.online ? '' : ' offline'}`;

      const nameWrap = document.createElement('span');
      nameWrap.className = 'group-dm-picker-names';

      const displayName = document.createElement('span');
      displayName.className = 'group-dm-picker-display';
      displayName.textContent = u.display_name || u.username;

      const username = document.createElement('span');
      username.className = 'group-dm-picker-username';
      username.textContent = `@${u.username}`;

      nameWrap.append(displayName, username);
      row.append(cb, dot, nameWrap);
      inviteListEl.appendChild(row);
    });
  }

  async function openManageModal() {
    if (!manageModal) return;
    if (state.activeRoom.type !== 'channel') return;
    const chanId = Number(state.activeRoom.id);
    currentManageGdmId = chanId;
    selectedInviteIds.clear();
    updateInviteCount();
    if (manageErrorEl) manageErrorEl.textContent = '';
    if (inviteSearchInput) inviteSearchInput.value = '';

    manageModal.classList.remove('hidden');

    try {
      const res = await fetch(`/api/group-dms/${chanId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('그룹 대화 정보를 불러오지 못했습니다.');
      const detail = await res.json();

      if (manageNameInput) manageNameInput.value = detail.display_name || '';
      if (memberCountSpan) memberCountSpan.textContent = String(detail.member_count || detail.members?.length || 0);

      // Render members
      if (membersListEl) {
        membersListEl.replaceChildren();
        const existingMemberIds = new Set();
        (detail.members || []).forEach(m => {
          existingMemberIds.add(Number(m.id));
          const row = document.createElement('div');
          row.className = 'group-dm-member-row';

          const left = document.createElement('div');
          left.className = 'group-dm-member-left';

          const dot = document.createElement('span');
          const isOnline = userDirectory.get(m.username)?.online ?? false;
          dot.className = `online-dot${isOnline ? '' : ' offline'}`;

          const name = document.createElement('span');
          name.className = 'group-dm-member-name';
          name.textContent = m.display_name || m.username;
          if (m.id === state.currentUser?.id) {
            name.textContent += ' (나)';
          }

          const uname = document.createElement('span');
          uname.className = 'group-dm-member-username';
          uname.textContent = `@${m.username}`;

          left.append(dot, name, uname);
          row.appendChild(left);
          membersListEl.appendChild(row);
        });

        // Load candidate users for invite
        const allCandidates = await loadCandidateUsers();
        availableInviteUsers = allCandidates.filter(u => !existingMemberIds.has(Number(u.id)));
        renderInvitePicker();
      }
    } catch (err) {
      if (manageErrorEl) manageErrorEl.textContent = err.message;
    }
  }

  function closeManageModal() {
    manageModal?.classList.add('hidden');
    currentManageGdmId = null;
  }

  manageBtn?.addEventListener('click', openManageModal);
  manageClose?.addEventListener('click', closeManageModal);
  manageModal?.addEventListener('click', (e) => {
    if (e.target === manageModal) closeManageModal();
  });

  inviteSearchInput?.addEventListener('input', () => {
    renderInvitePicker(inviteSearchInput.value);
  });

  // Rename Group DM
  manageNameForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentManageGdmId) return;
    const newName = manageNameInput?.value.trim() || '';
    if (manageErrorEl) manageErrorEl.textContent = '';
    if (manageNameSave) manageNameSave.disabled = true;

    try {
      const res = await fetch(`/api/group-dms/${currentManageGdmId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.detail || '이름 변경에 실패했습니다.');
      }
      const updated = await res.json();
      showToast('그룹 대화 이름이 변경되었습니다.', 'success');
      await loadGroupDms(onSwitchConv);
      if (state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(currentManageGdmId)) {
        const chatAreaTitle = document.getElementById('chat-area-title');
        const displayName = updated.effective_name || updated.display_name || '그룹 대화';
        if (chatAreaTitle) chatAreaTitle.textContent = `👥 ${displayName}`;
      }
    } catch (err) {
      if (manageErrorEl) manageErrorEl.textContent = err.message;
    } finally {
      if (manageNameSave) manageNameSave.disabled = false;
    }
  });

  // Invite Members
  inviteSubmitBtn?.addEventListener('click', async () => {
    if (!currentManageGdmId || selectedInviteIds.size === 0) return;
    if (manageErrorEl) manageErrorEl.textContent = '';
    inviteSubmitBtn.disabled = true;

    try {
      const res = await fetch(`/api/group-dms/${currentManageGdmId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_ids: Array.from(selectedInviteIds) }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.detail || '참여자 초대에 실패했습니다.');
      }
      showToast('새 참여자를 초대했습니다.', 'success');
      await loadGroupDms(onSwitchConv);
      await openManageModal(); // Refresh modal state
    } catch (err) {
      if (manageErrorEl) manageErrorEl.textContent = err.message;
      inviteSubmitBtn.disabled = false;
    }
  });

  // Leave Group DM
  leaveBtn?.addEventListener('click', async () => {
    if (!currentManageGdmId) return;
    if (!confirm('정말 이 그룹 대화방을 나가시겠습니까? 대화 기록을 더 이상 볼 수 없습니다.')) return;
    if (manageErrorEl) manageErrorEl.textContent = '';
    leaveBtn.disabled = true;

    try {
      const res = await fetch(`/api/group-dms/${currentManageGdmId}/members/me`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.detail || '대화방 나가기에 실패했습니다.');
      }
      closeManageModal();
      showToast('그룹 대화방을 나갔습니다.', 'info');
      await loadGroupDms(onSwitchConv);
      onSwitchConv('channel', 1);
    } catch (err) {
      if (manageErrorEl) manageErrorEl.textContent = err.message;
      leaveBtn.disabled = false;
    }
  });
}

// --- App Bootstrap ---
function initApp() {
  initTouchableViewport();
  document.getElementById('message-list')?.addEventListener('scroll', checkAndAckActiveConversation, { passive: true });
  document.getElementById('new-messages-btn')?.addEventListener('click', checkAndAckActiveConversation);
  const sidebarToggle = document.getElementById('sidebar-toggle');

  const sidebar = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const headerNotifBtn = document.getElementById('header-notif-btn');
  const convMuteBtn = document.getElementById('conv-mute-btn');
  const globalNotificationModalClose = document.getElementById('global-notification-modal-close');
  const globalNotificationModalCancel = document.getElementById('global-notification-modal-cancel');
  const convNotificationModalClose = document.getElementById('conv-notification-modal-close');
  const convNotificationModalCancel = document.getElementById('conv-notification-modal-cancel');
  const convNotificationToggleBtn = document.getElementById('conv-notification-toggle-btn') || document.getElementById('conv-notif-toggle-btn');
  const soundModeInputs = document.querySelectorAll('input[name="sound-mode"]');
  const soundVolumeSlider = document.getElementById('sound-volume-slider');
  const soundTestBtn = document.getElementById('sound-test-btn');
  const desktopNotifToggleBtn = document.getElementById('desktop-notif-toggle-btn');
  const desktopNotifTestBtn = document.getElementById('desktop-notif-test-btn');
  const snoozeButtons = document.querySelectorAll('.snooze-btn');
  const snoozeResumeBtn = document.getElementById('snooze-resume-btn');

  // 1. Mobile Sidebar toggle
  if (sidebarToggle && sidebar && sidebarBackdrop) {
    sidebarToggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('hidden', !open);
    });
    sidebarBackdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.add('hidden');
    });
  }

  // 2. Notification Modals & Settings
  if (headerNotifBtn) headerNotifBtn.addEventListener('click', openGlobalNotificationModal);
  if (globalNotificationModalClose) globalNotificationModalClose.addEventListener('click', closeGlobalNotificationModal);
  if (globalNotificationModalCancel) globalNotificationModalCancel.addEventListener('click', closeGlobalNotificationModal);

  if (convMuteBtn) convMuteBtn.addEventListener('click', openConvNotificationModal);
  if (convNotificationModalClose) convNotificationModalClose.addEventListener('click', closeConvNotificationModal);
  if (convNotificationModalCancel) convNotificationModalCancel.addEventListener('click', closeConvNotificationModal);

  if (convNotificationToggleBtn) {
    convNotificationToggleBtn.addEventListener('click', async () => {
      const key = `${state.activeRoom.type}:${state.activeRoom.id}`;
      const isMuted = state.mutedConversations.has(key);
      const newMuted = !isMuted;
      try {
        const res = await fetch('/api/read-states/mute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_type: state.activeRoom.type,
            conversation_id: state.activeRoom.id,
            muted: newMuted,
          }),
        });
        if (res.ok) {
          if (newMuted) state.mutedConversations.add(key);
          else state.mutedConversations.delete(key);
          updateConversationNotificationUI();
          renderChannels(switchConversation);
          renderDms(switchConversation);
          showToast(newMuted ? '대화방을 음소거했습니다.' : '대화방 음소거를 해제했습니다.', 'info');
        }
      } catch { /* ignore */ }
    });
  }

  if (soundModeInputs) {
    soundModeInputs.forEach(input => {
      input.addEventListener('change', () => {
        setSoundMode(input.value);
      });
    });
  }

  if (soundVolumeSlider) {
    soundVolumeSlider.addEventListener('input', () => {
      const val = Number(soundVolumeSlider.value) / 100;
      setSoundVolume(val);
      const soundVolumeVal = document.getElementById('sound-volume-val');
      if (soundVolumeVal) soundVolumeVal.textContent = `${soundVolumeSlider.value}%`;
    });
  }

  if (soundTestBtn) {
    soundTestBtn.addEventListener('click', () => playNotificationSound(true));
  }

  if (desktopNotifTestBtn) {
    desktopNotifTestBtn.addEventListener('click', () => {
      showDesktopNotification({ title: 'BambooChat 테스트 알림', body: '데스크톱 알림이 정상적으로 작동합니다.' });
      showToast('테스트 알림을 전송했습니다.', 'info');
    });
  }
  if (desktopNotifToggleBtn) {
    desktopNotifToggleBtn.addEventListener('click', async () => {
      const { hasSupport, permission } = checkDesktopNotificationContext();
      if (!hasSupport) return;
      if (permission === 'default') {
        try {
          const res = await Notification.requestPermission();
          if (res === 'granted') setDesktopNotificationEnabled(true);
        } catch { /* ignore */ }
      } else if (permission === 'granted') {
        setDesktopNotificationEnabled(!isDesktopNotificationEnabled());
      }
      updateGlobalNotificationUI();
    });
  }

  if (snoozeButtons) {
    snoozeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        setSnooze(btn.dataset.snooze);
      });
    });
  }

  if (snoozeResumeBtn) {
    snoozeResumeBtn.addEventListener('click', clearSnooze);
  }

  // --- Sidebar Section Collapse & Draggable Sliders ---
  const SIDEBAR_SIZES_STORAGE_KEY = 'bamboochat_sidebar_sizes';
  const SIDEBAR_COLLAPSED_STORAGE_KEY = 'bamboochat_sidebar_collapsed';

  function initSidebarSections() {
    const toggleButtons = document.querySelectorAll('.section-toggle-btn');
    toggleButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.closest('.sidebar-section');
        if (!section) return;
        const isCollapsed = section.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!isCollapsed));
        if (!isCollapsed) {
          try {
            const sizes = JSON.parse(localStorage.getItem(SIDEBAR_SIZES_STORAGE_KEY) || '{}');
            const secName = section.dataset.section;
            if (secName && sizes[secName] && sizes[secName] >= 50) {
              section.style.flex = `0 0 ${sizes[secName]}px`;
            }
          } catch { /* storage */ }
        }
        saveSidebarState();
      });
    });

    const sliders = document.querySelectorAll('.sidebar-slider');
    sliders.forEach(slider => {
      slider.addEventListener('pointerdown', event => {
        const prevSection = slider.previousElementSibling;
        const nextSection = slider.nextElementSibling;
        if (!prevSection || !nextSection) return;
        if (prevSection.classList.contains('collapsed') || nextSection.classList.contains('collapsed')) return;

        event.preventDefault();
        slider.classList.add('is-dragging');
        slider.setPointerCapture(event.pointerId);

        const startY = event.clientY;
        const startPrevHeight = prevSection.getBoundingClientRect().height;
        const startNextHeight = nextSection.getBoundingClientRect().height;

        const onPointerMove = moveEvent => {
          const deltaY = moveEvent.clientY - startY;
          const newPrevHeight = Math.max(50, startPrevHeight + deltaY);
          const newNextHeight = Math.max(50, startNextHeight - deltaY);
          prevSection.style.flex = `0 0 ${newPrevHeight}px`;
          nextSection.style.flex = `0 0 ${newNextHeight}px`;
        };

        const onPointerUp = upEvent => {
          slider.classList.remove('is-dragging');
          try { slider.releasePointerCapture(upEvent.pointerId); } catch { /* ignore */ }
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          saveSidebarState();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
      });
    });

    restoreSidebarState();
  }

  function saveSidebarState() {
    try {
      const collapsed = [];
      const sizes = {};
      document.querySelectorAll('.sidebar-section').forEach(sec => {
        const secName = sec.dataset.section;
        if (!secName) return;
        if (sec.classList.contains('collapsed')) {
          collapsed.push(secName);
        } else {
          sizes[secName] = sec.getBoundingClientRect().height;
        }
      });
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
      localStorage.setItem(SIDEBAR_SIZES_STORAGE_KEY, JSON.stringify(sizes));
    } catch { /* storage */ }
  }

  function restoreSidebarState() {
    try {
      const collapsed = JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) || '[]');
      const sizes = JSON.parse(localStorage.getItem(SIDEBAR_SIZES_STORAGE_KEY) || '{}');

      document.querySelectorAll('.sidebar-section').forEach(sec => {
        const secName = sec.dataset.section;
        if (!secName) return;
        const btn = sec.querySelector('.section-toggle-btn');
        if (collapsed.includes(secName)) {
          sec.classList.add('collapsed');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        } else if (sizes[secName] && sizes[secName] >= 50) {
          sec.style.flex = `0 0 ${sizes[secName]}px`;
        }
      });
    } catch { /* storage */ }
  }

  // 3. Initialize modules
  initChatListeners(handleSendMessage);
  initChannelsListeners(switchConversation);
  initGroupDmModals(switchConversation);
  initPinsListeners();
  initQuizListeners();
  initPlayHubListeners();
  void initOptionalGameModules();
  initSearchListeners(switchConversation);
  initScreenShareUI();
  initSidebarSections();
  window.bambooChatSwitchChannel = (cid) => switchConversation('channel', cid);
  window.bambooChatSwitchConversation = (type, id) => switchConversation(type, id);
  window.bambooChatRenderDms = () => renderDms(switchConversation);

  // 4. Load older messages button
  const loadOlderBtn = document.getElementById('load-older-btn');
  if (loadOlderBtn) loadOlderBtn.addEventListener('click', loadOlderMessages);
  initMessageScroll();
  initReplyReturnButton();

  const onLoginSuccess = async (user) => {
    const chatApp = document.getElementById('chat-app');
    const adminBtn = document.getElementById('admin-btn');
    const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
    if (chatApp) chatApp.classList.remove('hidden');
    if (adminBtn) adminBtn.classList.toggle('hidden', user?.role !== 'admin');
    if (quizNavAdminBtn) quizNavAdminBtn.classList.toggle('hidden', user?.role !== 'admin');
    updateNickBadge();
    loadDrafts();
    await Promise.all([
      loadChannels(switchConversation),
      loadGroupDms(switchConversation),
      loadScreenshares(),
    ]);
    await switchConversation('channel', 1);
    initWebSocket({
      onSwitchConv: (convKey) => {
        const [type, ...rest] = convKey.split(':');
        switchConversation(type, rest.join(':'));
      },
      onOpenDm: (nick) => switchConversation('dm', nick),
      onDmsUpdated: () => renderDms(switchConversation),
      onGroupDmCreated: async () => {
        await loadGroupDms(switchConversation);
        renderChannels(switchConversation);
      },
      onGroupDmUpdated: async (chanId, gdm) => {
        await loadGroupDms(switchConversation);
        if (state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(chanId)) {
          const chatAreaTitle = document.getElementById('chat-area-title');
          const chatAreaDesc = document.getElementById('chat-area-desc');
          if (gdm) {
            const displayName = gdm.effective_name || gdm.display_name || '그룹 대화';
            const memberNames = (gdm.members || []).map(m => m.display_name || m.username).join(', ');
            if (chatAreaTitle) chatAreaTitle.textContent = `👥 ${displayName}`;
            if (chatAreaDesc) chatAreaDesc.textContent = `참여자 ${gdm.member_count || gdm.members?.length || 0}명: ${memberNames}`;
          }
        }
      },
      onGroupDmMemberLeft: async (chanId, userId) => {
        if (userId === state.currentUser?.id) {
          if (state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(chanId)) {
            switchConversation('channel', 1);
          }
        }
        await loadGroupDms(switchConversation);
        if (state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(chanId)) {
          const detail = state.groupDms?.find(g => Number(g.id) === Number(chanId));
          if (detail) {
            const chatAreaDesc = document.getElementById('chat-area-desc');
            const memberNames = (detail.members || []).map(m => m.display_name || m.username).join(', ');
            if (chatAreaDesc) chatAreaDesc.textContent = `참여자 ${detail.member_count || detail.members?.length || 0}명: ${memberNames}`;
          }
        }
      },
      onUnreadUpdated: (counts) => {
        if (counts) applyServerUnreadCounts(counts);
        renderChannels(switchConversation);
        renderDms(switchConversation);
      },
      onMuteUpdated: () => {
        updateConversationNotificationUI();
        renderChannels(switchConversation);
        renderDms(switchConversation);
      },
      onChannelUpdated: () => renderChannels(switchConversation),
      onMessageEdited: (msg) => updateMessageInDOM(msg),
      onMessageHidden: (msg, isHidden) => updateMessageHiddenInDOM(msg, isHidden),
      onMessageMoved: (msgId) => removeMessageFromDOM(msgId),
      onAttachmentDeleted: (attachmentId) => applyAttachmentDeletedInDOM(attachmentId),
      onChannelArchived: (channelId) => {
        if (state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(channelId)) {
          switchConversation('channel', 1);
        }
      },
      onNewMessage: (message) => {
        const messageType = message.msgType === 'dm' ? 'dm' : 'channel';
        const isActive = messageType === 'channel'
          ? state.activeRoom.type === 'channel' && String(state.activeRoom.id) === String(message.channel_id)
          : state.activeRoom.type === 'dm'
            && [message.from_nick, message.to_nick].includes(String(state.activeRoom.id));
        if (isActive && isChatActiveAndFocused() && isNearLatest()) {
          acknowledgeConversation(state.activeRoom.type, state.activeRoom.id, message.message_id);
        }
      },
      onLeaderboardInvalidated: (event) => handleLeaderboardInvalidated(event),
      onSessionExpired: () => {
        resetScreenShare();
        setCurrentUser(null);
        if (state.socket) state.socket = null;
        showAuthModal('세션이 만료되었습니다. 다시 로그인해 주세요.');
      },
    });
    showNicknameHint();
    refreshQuizHeaderStreak();
    refreshQuizSidebarCounts();
    refreshStorageWarning();
    setTimeout(showSearchHint, 12000);
  };



  const onLogout = () => {
    resetScreenShare();
    acknowledgedMessageIds.clear();
    const chatApp = document.getElementById('chat-app');
    if (chatApp) chatApp.classList.add('hidden');
    if (state.socket) {
      state.socket.close();
      state.socket = null;
    }
  };

  initAuthListeners(onLoginSuccess, onLogout);
  bootstrapAuth(onLoginSuccess);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

