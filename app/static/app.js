/**
 * BambooChat client: authenticated conversations, safe Markdown, replies, drafts and files.
 */
'use strict';

const DRAFTS_PREFIX = 'bamboochat_drafts_';
const SAVED_USERNAME_KEY = 'bamboochat_saved_username';
const RECONNECT_DELAY = 3000;
const GLOBAL_ID = 'channel:1';

const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const passwordConfirmInput = document.getElementById('password-confirm-input');
const enrollmentInput = document.getElementById('enrollment-input');
const rememberIdInput = document.getElementById('remember-id-input');
const authRememberRow = document.getElementById('auth-remember-row');
const registerFields = document.getElementById('register-fields');
const authSubmit = document.getElementById('auth-submit');
const authModeToggle = document.getElementById('auth-mode-toggle');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
const adminBtn = document.getElementById('admin-btn');
const adminModal = document.getElementById('admin-modal');
const adminClose = document.getElementById('admin-close');
const adminStorage = document.getElementById('admin-storage');
const adminRegistrationEnabled = document.getElementById('admin-registration-enabled');
const adminRegistrationSave = document.getElementById('admin-registration-save');
const adminEnrollmentCode = document.getElementById('admin-enrollment-code');
const adminEnrollmentSave = document.getElementById('admin-enrollment-save');
const adminUsers = document.getElementById('admin-users');
const adminError = document.getElementById('admin-error');
const chatApp = document.getElementById('chat-app');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const convListEl = document.getElementById('conv-list');
const channelListEl = document.getElementById('channel-list');
const dmListEl = document.getElementById('dm-list');
const createChannelBtn = document.getElementById('create-channel-btn');
const channelModal = document.getElementById('channel-modal');
const channelModalClose = document.getElementById('channel-modal-close');
const channelForm = document.getElementById('channel-form');
const channelDisplayInput = document.getElementById('channel-display-input');
const channelNameInput = document.getElementById('channel-name-input');
const channelDescInput = document.getElementById('channel-desc-input');
const channelError = document.getElementById('channel-error');
const channelSubmit = document.getElementById('channel-submit');
const channelSettingsBtn = document.getElementById('channel-settings-btn');
const channelEditModal = document.getElementById('channel-edit-modal');
const channelEditModalClose = document.getElementById('channel-edit-modal-close');
const channelEditForm = document.getElementById('channel-edit-form');
const channelEditId = document.getElementById('channel-edit-id');
const channelEditDisplayInput = document.getElementById('channel-edit-display-input');
const channelEditNameInput = document.getElementById('channel-edit-name-input');
const channelEditDescInput = document.getElementById('channel-edit-desc-input');
const channelEditError = document.getElementById('channel-edit-error');
const channelEditSubmit = document.getElementById('channel-edit-submit');
const channelArchiveBtn = document.getElementById('channel-archive-btn');
const channelDeleteBtn = document.getElementById('channel-delete-btn');
const moveMessageModal = document.getElementById('move-message-modal');
const moveMessageModalClose = document.getElementById('move-message-modal-close');
const moveMessageForm = document.getElementById('move-message-form');
const moveMessageId = document.getElementById('move-message-id');
const moveMessageChannelSelect = document.getElementById('move-message-channel-select');
const moveMessageError = document.getElementById('move-message-error');
const moveMessageSubmit = document.getElementById('move-message-submit');
const onlineListEl = document.getElementById('online-list');
const onlineCountEl = document.getElementById('online-count');
const userCountEl = document.getElementById('user-count');
const messageListEl = document.getElementById('message-list');
const loadOlderBtn = document.getElementById('load-older-btn');
const msgInput = document.getElementById('msg-input');
const markdownToolbar = document.getElementById('markdown-toolbar');
const mentionMenu = document.getElementById('mention-menu');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const chatAreaTitle = document.getElementById('chat-area-title');
const chatAreaDesc = document.getElementById('chat-area-desc');
const convMuteBtn = document.getElementById('conv-mute-btn');
const muteHintPopover = document.getElementById('mute-hint-popover');
const muteHintClose = document.getElementById('mute-hint-close');
const muteHintTitle = document.getElementById('mute-hint-title');
const muteHintDesc = document.getElementById('mute-hint-desc');
const muteHintIcon = document.getElementById('mute-hint-icon');
const notificationModal = document.getElementById('notification-modal');
const notificationModalClose = document.getElementById('notification-modal-close');
const notificationModalCancel = document.getElementById('notification-modal-cancel');
const notificationModalDesc = document.getElementById('notification-modal-desc');
const notificationStatusIcon = document.getElementById('notification-status-icon');
const notificationStatusTitle = document.getElementById('notification-status-title');
const notificationStatusDesc = document.getElementById('notification-status-desc');
const notificationToggleBtn = document.getElementById('notification-toggle-btn');
const headerNotifBtn = document.getElementById('header-notif-btn');
const notifConvSection = document.getElementById('notif-conv-section');
const soundModeInputs = document.querySelectorAll('input[name="sound-mode"]');
const soundVolumeSlider = document.getElementById('sound-volume-slider');
const soundVolumeVal = document.getElementById('sound-volume-val');
const soundTestBtn = document.getElementById('sound-test-btn');
const desktopNotifToggleBtn = document.getElementById('desktop-notif-toggle-btn');
const desktopNotifTestBtn = document.getElementById('desktop-notif-test-btn');
const desktopNotifStatusBadge = document.getElementById('desktop-notif-status-badge');
const desktopNotifStatusDesc = document.getElementById('desktop-notif-status-desc');
const desktopNotifHint = document.getElementById('desktop-notif-hint');
const snoozeStatusBadge = document.getElementById('snooze-status-badge');
const snoozeDesc = document.getElementById('snooze-desc');
const snoozeResumeBtn = document.getElementById('snooze-resume-btn');
const snoozeButtons = document.querySelectorAll('.snooze-btn[data-snooze]');
const retentionNote = document.getElementById('retention-note');
const connStatus = document.getElementById('conn-status');
const myNickBadge = document.getElementById('my-nick-badge');
const nicknameHintPopover = document.getElementById('nickname-hint-popover');
const nicknameHintClose = document.getElementById('nickname-hint-close');
const notifHintPopover = document.getElementById('notif-hint-popover');
const notifHintClose = document.getElementById('notif-hint-close');
const charCount = document.getElementById('char-count');
const nicknameModal = document.getElementById('nickname-modal');
const nicknameClose = document.getElementById('nickname-close');
const nicknameForm = document.getElementById('nickname-form');
const nicknameInput = document.getElementById('nickname-input');
const nicknameError = document.getElementById('nickname-error');
const nicknameSubmit = document.getElementById('nickname-submit');
const nicknameCurrentName = document.getElementById('nickname-current-name');
const nicknameUsernameLabel = document.getElementById('nickname-username-label');
const replyPreview = document.getElementById('reply-preview');
const replyPreviewName = document.getElementById('reply-preview-name');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancel = document.getElementById('reply-cancel');
const attachmentPreview = document.getElementById('attachment-preview');
const attachmentList = document.getElementById('attachment-list');
const dropOverlay = document.getElementById('drop-overlay');
const toastRegion = document.getElementById('toast-region');
const chatArea = document.querySelector('.chat-area');
const MAX_MSG_LEN = msgInput.maxLength;
const MAX_FILE_MB = Number(fileInput.dataset.maxFileMb || 50);
const MAX_FILES = Number(fileInput.dataset.maxFiles || 5);
const MAX_PARALLEL_UPLOADS = 2;

const conversations = new Map();
const channelsDirectory = new Map();
const userConversationStates = new Map();
const userUnreadCounts = new Map();
const replyTargets = new Map();
const pendingAttachments = new Map();
const userDirectory = new Map();
let drafts = {};
let activeConvId = GLOBAL_ID;
let currentUser = null;
let myNickname = '';
let myDisplayName = '';
let myUserId = null;
let ws = null;
let reconnectTimer = null;
let nicknameHintTimer = null;
let authMode = 'login';
let lastStorageWarning = 0;
let dragDepth = 0;
let attachmentSequence = 0;
let mentionUsers = [];
let mentionMatches = [];
let mentionActiveIndex = 0;
let mentionRange = null;

function draftsKey() {
  return currentUser ? DRAFTS_PREFIX + currentUser.id : '';
}

function loadDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(draftsKey()) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function persistDrafts() {
  if (!currentUser) return;
  try { localStorage.setItem(draftsKey(), JSON.stringify(drafts)); } catch { /* storage unavailable */ }
}

function getOrCreateChannel(chan) {
  const convId = 'channel:' + chan.id;
  if (!conversations.has(convId)) {
    conversations.set(convId, {
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
    });
  } else {
    const conv = conversations.get(convId);
    conv.displayName = chan.display_name;
    conv.description = chan.description || '';
    conv.name = chan.name;
    conv.isDefault = Boolean(chan.is_default);
  }
  return conversations.get(convId);
}

function initConversations() {
  conversations.clear();
  channelsDirectory.clear();
  const defaultChan = { id: 1, name: 'general', display_name: '전체 채팅', description: '기본 전체 공개 대화방', is_default: true };
  channelsDirectory.set(1, defaultChan);
  getOrCreateChannel(defaultChan);
  activeConvId = GLOBAL_ID;
}

async function loadChannels() {
  if (!currentUser) return;
  try {
    const response = await fetch('/api/channels', { cache: 'no-store' });
    if (!response.ok) return;
    const channels = await response.json();
    if (Array.isArray(channels)) {
      channels.forEach(chan => {
        channelsDirectory.set(chan.id, chan);
        getOrCreateChannel(chan);
      });
      renderConversationList();
      const activeConv = conversations.get(activeConvId);
      if (activeConv && activeConv.type === 'channel') {
        const chanObj = channelsDirectory.get(activeConv.channelId);
        if (chanObj) {
          chatAreaTitle.textContent = `# ${chanObj.display_name}`;
          if (chatAreaDesc) chatAreaDesc.textContent = chanObj.description || '';
        }
      }
    }
  } catch { /* advisory */ }
}

function displayNickname(nick) {
  const entry = userDirectory.get(nick);
  return entry?.display_name || nick;
}

function getOrCreateDm(nick, partnerUserId = null) {
  if (!conversations.has(nick)) {
    conversations.set(nick, {
      id: nick, name: nick, type: 'dm', partnerUserId: partnerUserId, messages: [],
      messageIds: new Set(), unread: 0, hasOlder: false, loadingOlder: false,
      lastActivityTime: 0,
    });
  }
  const conv = conversations.get(nick);
  if (partnerUserId && !conv.partnerUserId) {
    conv.partnerUserId = partnerUserId;
  }
  return conv;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  registerFields.classList.toggle('hidden', !registering);
  if (authRememberRow) authRememberRow.classList.toggle('hidden', registering);
  authSubmit.textContent = registering ? '계정 만들기' : '로그인';
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  if (authModeToggle) {
    authModeToggle.textContent = registering ? '이미 계정이 있나요? 로그인' : '처음인가요? 계정 만들기';
  }
  authError.textContent = '';
}

function showAuthModal(message = '') {
  authError.textContent = message;
  authModal.classList.remove('hidden');
  chatApp.classList.add('hidden');
  const savedUsername = localStorage.getItem(SAVED_USERNAME_KEY);
  if (savedUsername) {
    usernameInput.value = savedUsername;
    if (rememberIdInput) rememberIdInput.checked = true;
    setTimeout(() => passwordInput.focus(), 50);
  } else {
    if (rememberIdInput) rememberIdInput.checked = false;
    setTimeout(() => usernameInput.focus(), 50);
  }
}

function hideAuthModal() {
  authModal.classList.add('hidden');
}

let notifHintTimer = null;

function showNicknameHint() {
  if (!nicknameHintPopover) return;
  if (nicknameHintTimer) clearTimeout(nicknameHintTimer);
  nicknameHintPopover.classList.remove('hidden');
  nicknameHintTimer = setTimeout(() => {
    hideNicknameHint(true);
  }, 6000);
}

function hideNicknameHint(triggerNext = true) {
  if (nicknameHintTimer) {
    clearTimeout(nicknameHintTimer);
    nicknameHintTimer = null;
  }
  if (nicknameHintPopover) {
    nicknameHintPopover.classList.add('hidden');
  }
  if (triggerNext && currentUser) {
    showNotifHint();
  }
}

function showNotifHint() {
  if (!notifHintPopover || !currentUser) return;
  if (notifHintTimer) clearTimeout(notifHintTimer);
  notifHintPopover.classList.remove('hidden');
  notifHintTimer = setTimeout(() => {
    hideNotifHint();
  }, 6000);
}

function hideNotifHint() {
  if (notifHintTimer) {
    clearTimeout(notifHintTimer);
    notifHintTimer = null;
  }
  if (notifHintPopover) {
    notifHintPopover.classList.add('hidden');
  }
}

function updateNickBadge() {
  const name = myDisplayName || myNickname;
  const suffix = currentUser?.role === 'admin' ? ' · 관리자' : '';
  myNickBadge.textContent = name + suffix;
  myNickBadge.title = `${name} (@${myNickname}) — 닉네임 변경`;
}

async function enterChat(user) {
  currentUser = user;
  myUserId = Number(user.id);
  myNickname = user.username;
  myDisplayName = user.display_name || user.username;
  updateNickBadge();
  adminBtn.classList.toggle('hidden', user.role !== 'admin');
  drafts = loadDrafts();
  hideAuthModal();
  initConversations();
  chatApp.classList.remove('hidden');
  await loadChannels();
  switchConversation(GLOBAL_ID);
  initWebSocket();
  refreshStorageWarning();
  showNicknameHint();
  showMuteHint();
}

async function submitAuth(event) {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    authError.textContent = '아이디와 비밀번호를 입력해 주세요.';
    return;
  }
  const body = { username, password };
  if (authMode === 'register') {
    if (password !== passwordConfirmInput.value) {
      authError.textContent = '비밀번호가 일치하지 않습니다.';
      return;
    }
    body.enrollment_code = enrollmentInput.value;
  }
  authSubmit.disabled = true;
  authError.textContent = '';
  try {
    const response = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '요청을 처리하지 못했습니다.');
    if (rememberIdInput && rememberIdInput.checked) {
      localStorage.setItem(SAVED_USERNAME_KEY, username);
    } else {
      localStorage.removeItem(SAVED_USERNAME_KEY);
    }
    passwordInput.value = '';
    passwordConfirmInput.value = '';
    enrollmentInput.value = '';
    await enterChat(data);
  } catch (error) {
    authError.textContent = error.message || '로그인하지 못했습니다.';
  } finally {
    authSubmit.disabled = false;
  }
}

async function logout() {
  hideNicknameHint(false);
  hideNotifHint();
  hideMuteHint();
  saveCurrentDraft();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* session expires anyway */ }
  currentUser = null;
  myUserId = null;
  myNickname = '';
  myDisplayName = '';
  drafts = {};
  lastStorageWarning = 0;
  pendingAttachments.clear();
  userDirectory.clear();
  mentionUsers = [];
  closeMentionMenu();
  adminBtn.classList.add('hidden');
  adminModal.classList.add('hidden');
  helpModal.classList.add('hidden');
  nicknameModal.classList.add('hidden');
  if (notificationModal) notificationModal.classList.add('hidden');
  if (channelModal) channelModal.classList.add('hidden');
  if (channelEditModal) channelEditModal.classList.add('hidden');
  if (channelSettingsBtn) channelSettingsBtn.classList.add('hidden');
  channelsDirectory.clear();
  messageListEl.replaceChildren();
  setConnected(false);
  setAuthMode('login');
  updateDocumentTitle();
  showAuthModal();
}

async function refreshStorageWarning() {
  if (!currentUser) return;
  try {
    const response = await fetch('/api/storage', { cache: 'no-store' });
    if (!response.ok) return;
    const status = await response.json();
    const level = Number(status.warning_level || 0);
    if (level && level !== lastStorageWarning) {
      const tone = level >= 95 ? 'error' : 'warning';
      showToast(`저장 공간이 ${level}% 이상 사용 중입니다. 불필요한 파일을 삭제해 주세요.`, tone);
    }
    lastStorageWarning = level;
  } catch { /* status is advisory */ }
}

async function adminJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `관리 요청 실패 (${response.status})`);
  return data;
}

function storageLine(label, used, limit) {
  const percent = limit ? Math.round((used / limit) * 1000) / 10 : 0;
  return `${label}: ${formatBytes(used)} / ${formatBytes(limit)} (${percent}%)`;
}

function renderAdminUsers(users) {
  adminUsers.replaceChildren();
  users.forEach(user => {
    const savedActive = Boolean(user.active);
    const row = document.createElement('div');
    row.className = `admin-user${savedActive ? '' : ' inactive'}`;

    const identity = document.createElement('div');
    identity.className = 'admin-user-identity';
    const name = document.createElement('strong');
    name.textContent = user.username;
    const details = document.createElement('small');
    details.textContent = `메시지 ${user.message_count}개 · 파일 ${formatBytes(user.attachment_bytes)}`;
    identity.append(name, details);
    const ip = document.createElement('small');
    ip.textContent = `현재 접속 IP: ${user.current_ip || '없음'}`;
    identity.append(ip);

    const role = document.createElement('select');
    role.setAttribute('aria-label', `${user.username} 역할`);
    [['student', '학생'], ['admin', '관리자']].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = user.role === value;
      role.appendChild(option);
    });

    const activeLabel = document.createElement('label');
    activeLabel.className = 'admin-active-label';
    const active = document.createElement('input');
    active.type = 'checkbox';
    active.className = 'admin-active-input';
    active.checked = savedActive;
    active.setAttribute('role', 'switch');
    active.setAttribute('aria-label', `${user.username} 계정 활성 상태`);
    const toggleTrack = document.createElement('span');
    toggleTrack.className = 'admin-toggle-track';
    toggleTrack.setAttribute('aria-hidden', 'true');
    const activeText = document.createElement('span');
    activeText.className = 'admin-active-text';
    activeText.textContent = active.checked ? '활성' : '비활성';
    activeLabel.append(active, toggleTrack, activeText);

    const password = document.createElement('input');
    password.type = 'password';
    password.minLength = 5;
    password.placeholder = '새 비밀번호';
    password.autocomplete = 'new-password';
    password.setAttribute('aria-label', `${user.username} 새 비밀번호`);

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = '적용';
    const updatePendingState = () => {
      const hasPendingChanges = role.value !== user.role
        || active.checked !== savedActive
        || password.value.length > 0;
      row.classList.toggle('pending', hasPendingChanges);
      save.textContent = hasPendingChanges ? '변경 적용' : '적용';
    };
    role.addEventListener('change', updatePendingState);
    password.addEventListener('input', updatePendingState);
    const isSelf = Number(user.id) === myUserId;
    if (isSelf) {
      role.disabled = true;
      active.disabled = true;
      name.textContent += ' (현재 계정)';
      activeText.textContent = '---';
      activeLabel.classList.add('locked');
      activeLabel.title = '현재 로그인한 관리자 계정은 비활성화할 수 없습니다.';
    } else {
      active.addEventListener('change', () => {
        activeText.textContent = active.checked ? '활성' : '비활성';
        updatePendingState();
      });
    }
    save.addEventListener('click', async () => {
      save.disabled = true;
      adminError.textContent = '';
      try {
        await adminJson(`/api/admin/users/${user.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: role.value,
            active: active.checked,
            new_password: password.value || null,
          }),
        });
        showToast(`${user.username} 계정 설정을 저장했습니다.`, 'success');
        await loadAdminOverview();
      } catch (error) {
        adminError.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });

    const controls = document.createElement('div');
    controls.className = 'admin-user-controls';
    controls.append(role, activeLabel, password, save);
    row.append(identity, controls);
    adminUsers.appendChild(row);
  });
}

async function loadAdminOverview() {
  adminError.textContent = '';
  try {
    const overview = await adminJson('/api/admin/overview', { cache: 'no-store' });
    adminRegistrationEnabled.checked = Boolean(overview.registration_enabled);
    const storage = overview.storage;
    adminStorage.replaceChildren();
    [
      storageLine('첨부 파일', storage.attachment_bytes, storage.attachment_limit_bytes),
      storageLine('데이터베이스', storage.database_bytes, storage.database_limit_bytes),
    ].forEach(text => {
      const line = document.createElement('div');
      line.textContent = text;
      adminStorage.appendChild(line);
    });
    renderAdminUsers(overview.users || []);
  } catch (error) {
    adminError.textContent = error.message;
  }
}

async function openAdminPanel() {
  adminModal.classList.remove('hidden');
  await loadAdminOverview();
}

function closeAdminPanel() {
  adminModal.classList.add('hidden');
  adminEnrollmentCode.value = '';
  adminError.textContent = '';
}

function openHelpModal() {
  helpModal.classList.remove('hidden');
  helpClose.focus();
}

function closeHelpModal() {
  helpModal.classList.add('hidden');
  if (currentUser) msgInput.focus();
}

async function bootstrapAuth() {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) throw new Error('not signed in');
    await enterChat(await response.json());
  } catch {
    showAuthModal();
  }
}

authForm.addEventListener('submit', submitAuth);
if (authModeToggle) authModeToggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
logoutBtn.addEventListener('click', logout);
helpBtn.addEventListener('click', openHelpModal);
helpClose.addEventListener('click', closeHelpModal);
helpModal.addEventListener('click', event => {
  if (event.target === helpModal) closeHelpModal();
});
adminBtn.addEventListener('click', openAdminPanel);
adminClose.addEventListener('click', closeAdminPanel);
adminModal.addEventListener('click', event => {
  if (event.target === adminModal) closeAdminPanel();
});

function openNicknameModal() {
  hideNicknameHint();
  nicknameCurrentName.textContent = myDisplayName || myNickname;
  nicknameUsernameLabel.textContent = `@${myNickname}`;
  nicknameInput.value = '';
  nicknameError.textContent = '';
  nicknameModal.classList.remove('hidden');
  setTimeout(() => nicknameInput.focus(), 50);
}

function closeNicknameModal() {
  nicknameModal.classList.add('hidden');
  nicknameError.textContent = '';
  if (currentUser) msgInput.focus();
}

async function submitNickname(event) {
  event.preventDefault();
  const name = nicknameInput.value.trim();
  if (!name) {
    nicknameError.textContent = '닉네임을 입력해 주세요.';
    return;
  }
  nicknameSubmit.disabled = true;
  nicknameError.textContent = '';
  try {
    const response = await fetch('/api/auth/display-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '닉네임을 변경하지 못했습니다.');
    myDisplayName = data.display_name || name;
    if (currentUser) currentUser.display_name = myDisplayName;
    updateNickBadge();
    closeNicknameModal();
    showToast('닉네임을 변경했습니다.', 'success');
  } catch (error) {
    nicknameError.textContent = error.message || '닉네임을 변경하지 못했습니다.';
  } finally {
    nicknameSubmit.disabled = false;
  }
}

myNickBadge.addEventListener('click', openNicknameModal);
if (nicknameHintClose) {
  nicknameHintClose.addEventListener('click', event => {
    event.stopPropagation();
    hideNicknameHint();
  });
}
if (nicknameHintPopover) {
  nicknameHintPopover.addEventListener('click', () => {
    hideNicknameHint();
    openNicknameModal();
  });
}
nicknameClose.addEventListener('click', closeNicknameModal);
nicknameModal.addEventListener('click', event => {
  if (event.target === nicknameModal) closeNicknameModal();
});
nicknameForm.addEventListener('submit', submitNickname);
adminRegistrationSave.addEventListener('click', async () => {
  adminRegistrationSave.disabled = true;
  adminError.textContent = '';
  try {
    await adminJson('/api/admin/registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: adminRegistrationEnabled.checked }),
    });
    showToast('신규 가입 설정을 변경했습니다.', 'success');
  } catch (error) {
    adminError.textContent = error.message;
  } finally {
    adminRegistrationSave.disabled = false;
  }
});
adminEnrollmentSave.addEventListener('click', async () => {
  adminEnrollmentSave.disabled = true;
  adminError.textContent = '';
  try {
    await adminJson('/api/admin/enrollment-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment_code: adminEnrollmentCode.value }),
    });
    adminEnrollmentCode.value = '';
    showToast('교실 가입 코드를 변경했습니다.', 'success');
  } catch (error) {
    adminError.textContent = error.message;
  } finally {
    adminEnrollmentSave.disabled = false;
  }
});

function openChannelModal() {
  channelForm.reset();
  delete channelNameInput.dataset.manualEdit;
  channelError.textContent = '';
  channelSubmit.disabled = false;
  channelModal.classList.remove('hidden');
  channelDisplayInput.focus();
}

function closeChannelModal() {
  channelModal.classList.add('hidden');
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u3131-\u3163\uac00-\ud7a3._-]/g, '')
    .slice(0, 30);
}

if (createChannelBtn) createChannelBtn.addEventListener('click', openChannelModal);
if (channelModalClose) channelModalClose.addEventListener('click', closeChannelModal);
if (channelModal) {
  channelModal.addEventListener('click', event => {
    if (event.target === channelModal) closeChannelModal();
  });
}
if (channelDisplayInput) {
  channelDisplayInput.addEventListener('input', () => {
    if (!channelNameInput.dataset.manualEdit) {
      channelNameInput.value = slugify(channelDisplayInput.value);
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
    channelError.textContent = '';
    channelSubmit.disabled = true;
    const name = channelNameInput.value.trim();
    const displayName = channelDisplayInput.value.trim();
    const description = channelDescInput.value.trim();
    try {
      const response = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, display_name: displayName, description }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '채널을 만들지 못했습니다.');
      channelsDirectory.set(data.id, data);
      const conv = getOrCreateChannel(data);
      closeChannelModal();
      renderConversationList();
      switchConversation(conv.id);
      showToast(`#${data.display_name} 채널을 만들었습니다.`, 'success');
    } catch (err) {
      channelError.textContent = err.message || '채널을 만들지 못했습니다.';
    } finally {
      channelSubmit.disabled = false;
    }
  });
}

function openChannelEditModal(chan) {
  if (!chan || !channelEditModal) return;
  channelEditId.value = String(chan.id);
  channelEditDisplayInput.value = chan.display_name || '';
  channelEditNameInput.value = chan.name || '';
  channelEditDescInput.value = chan.description || '';
  channelEditError.textContent = '';
  channelEditSubmit.disabled = false;
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
  channelEditDisplayInput.focus();
}

function closeChannelEditModal() {
  if (channelEditModal) channelEditModal.classList.add('hidden');
}

function updateChannelData(chan) {
  if (!chan) return;
  channelsDirectory.set(chan.id, chan);
  const convId = 'channel:' + chan.id;
  const conv = conversations.get(convId);
  if (conv) {
    conv.name = chan.name;
    conv.displayName = chan.display_name;
    conv.description = chan.description;
  }
  if (activeConvId === convId) {
    chatAreaTitle.textContent = `# ${chan.display_name}`;
    if (chatAreaDesc) chatAreaDesc.textContent = chan.description || '';
    msgInput.placeholder = `# ${chan.display_name}에 메시지 입력`;
  }
  renderConversationList();
}

function removeChannelData(chanId) {
  channelsDirectory.delete(chanId);
  const convId = 'channel:' + chanId;
  conversations.delete(convId);
  if (activeConvId === convId) {
    switchConversation(GLOBAL_ID);
  }
  renderConversationList();
}

if (channelSettingsBtn) {
  channelSettingsBtn.addEventListener('click', () => {
    const conv = conversations.get(activeConvId);
    if (!conv || conv.type !== 'channel') return;
    const chan = channelsDirectory.get(conv.channelId);
    if (chan) openChannelEditModal(chan);
  });
}
if (channelEditModalClose) channelEditModalClose.addEventListener('click', closeChannelEditModal);
if (channelEditModal) {
  channelEditModal.addEventListener('click', event => {
    if (event.target === channelEditModal) closeChannelEditModal();
  });
}
if (channelArchiveBtn) {
  channelArchiveBtn.addEventListener('click', async () => {
    const chanId = Number(channelEditId.value);
    if (!chanId || chanId === 1) return;
    const chan = channelsDirectory.get(chanId);
    const displayName = chan?.display_name || `채널 ${chanId}`;
    if (!confirm(`'# ${displayName}' 채널을 보관하시겠습니까?\n채널 목록에서 숨겨지며 기존 대화 기록과 첨부파일은 안전하게 보존됩니다.`)) {
      return;
    }
    channelArchiveBtn.disabled = true;
    channelDeleteBtn.disabled = true;
    channelEditSubmit.disabled = true;
    try {
      const response = await fetch(`/api/channels/${chanId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unarchive: false }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '채널을 보관하지 못했습니다.');
      removeChannelData(chanId);
      closeChannelEditModal();
      showToast(`#${displayName} 채널이 보관되었습니다.`, 'info');
    } catch (err) {
      channelEditError.textContent = err.message || '채널을 보관하지 못했습니다.';
    } finally {
      channelArchiveBtn.disabled = false;
      channelDeleteBtn.disabled = false;
      channelEditSubmit.disabled = false;
    }
  });
}
if (channelDeleteBtn) {
  channelDeleteBtn.addEventListener('click', async () => {
    const chanId = Number(channelEditId.value);
    if (!chanId || chanId === 1) return;
    const chan = channelsDirectory.get(chanId);
    const displayName = chan?.display_name || `채널 ${chanId}`;
    if (!confirm(`'# ${displayName}' 채널을 정말로 영구 삭제하시겠습니까?\n채널 내 모든 대화 및 첨부파일이 완전히 삭제되며 복구할 수 없습니다.`)) {
      return;
    }
    channelArchiveBtn.disabled = true;
    channelDeleteBtn.disabled = true;
    channelEditSubmit.disabled = true;
    try {
      const response = await fetch(`/api/channels/${chanId}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '채널을 삭제하지 못했습니다.');
      removeChannelData(chanId);
      closeChannelEditModal();
      showToast(`#${displayName} 채널이 영구 삭제되었습니다.`, 'info');
    } catch (err) {
      channelEditError.textContent = err.message || '채널을 삭제하지 못했습니다.';
    } finally {
      channelArchiveBtn.disabled = false;
      channelDeleteBtn.disabled = false;
      channelEditSubmit.disabled = false;
    }
  });
}
if (channelEditForm) {
  channelEditForm.addEventListener('submit', async event => {
    event.preventDefault();
    channelEditError.textContent = '';
    channelEditSubmit.disabled = true;
    const chanId = Number(channelEditId.value);
    const name = channelEditNameInput.value.trim();
    const displayName = channelEditDisplayInput.value.trim();
    const description = channelEditDescInput.value.trim();
    try {
      const response = await fetch(`/api/channels/${chanId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, display_name: displayName, description }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '채널 정보를 수정하지 못했습니다.');
      updateChannelData(data);
      closeChannelEditModal();
      showToast(`#${data.display_name} 채널 정보가 수정되었습니다.`, 'success');
    } catch (err) {
      channelEditError.textContent = err.message || '채널 정보를 수정하지 못했습니다.';
    } finally {
      channelEditSubmit.disabled = false;
    }
  });
}

function openMoveMessageModal(msg) {
  if (!moveMessageModal || !msg) return;
  const rawId = String(msg.message_id || '').replace(/^public:/, '');
  moveMessageId.value = rawId;
  moveMessageError.textContent = '';
  moveMessageChannelSelect.replaceChildren();
  const currentChanId = Number(msg.channel_id || 1);
  const eligible = Array.from(channelsDirectory.values())
    .filter(chan => !chan.archived && Number(chan.id) !== currentChanId);
  eligible.forEach(chan => {
    const opt = document.createElement('option');
    opt.value = String(chan.id);
    opt.textContent = `# ${chan.display_name} (${chan.name})`;
    moveMessageChannelSelect.appendChild(opt);
  });
  if (eligible.length === 0) {
    showToast('이동할 수 있는 다른 활성 채널이 없습니다.', 'warning');
    return;
  }
  moveMessageModal.classList.remove('hidden');
}

function closeMoveMessageModal() {
  if (moveMessageModal) moveMessageModal.classList.add('hidden');
}

if (moveMessageModalClose) moveMessageModalClose.addEventListener('click', closeMoveMessageModal);
if (moveMessageModal) {
  moveMessageModal.addEventListener('click', event => {
    if (event.target === moveMessageModal) closeMoveMessageModal();
  });
}
if (moveMessageForm) {
  moveMessageForm.addEventListener('submit', async event => {
    event.preventDefault();
    moveMessageError.textContent = '';
    moveMessageSubmit.disabled = true;
    const rawId = moveMessageId.value;
    const toChannelId = Number(moveMessageChannelSelect.value);
    try {
      const response = await fetch(`/api/messages/${rawId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_channel_id: toChannelId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || '메시지를 이동하지 못했습니다.');
      const toChan = channelsDirectory.get(toChannelId);
      closeMoveMessageModal();
      showToast(`메시지를 '# ${toChan?.display_name || toChannelId}' 채널로 이동했습니다.`, 'success');
    } catch (err) {
      moveMessageError.textContent = err.message || '메시지를 이동하지 못했습니다.';
    } finally {
      moveMessageSubmit.disabled = false;
    }
  });
}

async function toggleMessageHidden(messageId, hidden) {
  const rawId = String(messageId).replace(/^public:/, '');
  try {
    const response = await fetch(`/api/messages/${rawId}/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '메시지 숨김 상태를 변경하지 못했습니다.');
    showToast(hidden ? '메시지를 숨김 처리했습니다.' : '메시지 숨김을 해제했습니다.', 'info');
  } catch (err) {
    showToast(err.message || '메시지 숨김 처리에 실패했습니다.', 'error');
  }
}

async function saveEditedMessage(messageId, newContent) {
  const rawId = String(messageId).replace(/^public:/, '');
  try {
    const response = await fetch(`/api/messages/${rawId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '메시지를 수정하지 못했습니다.');
    return true;
  } catch (err) {
    showToast(err.message || '메시지 수정에 실패했습니다.', 'error');
    return false;
  }
}

function enterInlineEditMode(row, msg) {
  const bubble = row.querySelector('.msg-bubble');
  if (!bubble || bubble.querySelector('.inline-edit-box')) return;
  row.classList.add('is-editing');
  const originalContent = msg.content || '';
  const editBox = document.createElement('div');
  editBox.className = 'inline-edit-box';
  const textarea = document.createElement('textarea');
  textarea.className = 'inline-edit-input';
  textarea.value = originalContent;
  textarea.maxLength = 1000;
  
  const adjustHeight = () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(280, Math.max(80, textarea.scrollHeight + 4)) + 'px';
  };
  textarea.addEventListener('input', adjustHeight);

  const actionsBox = document.createElement('div');
  actionsBox.className = 'inline-edit-actions';

  const hint = document.createElement('span');
  hint.className = 'inline-edit-hint';
  hint.textContent = 'Enter: 저장 · Shift+Enter: 줄바꿈 · Esc: 취소';

  const btnGroup = document.createElement('div');
  btnGroup.className = 'inline-edit-btn-group';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'inline-edit-save';
  saveBtn.textContent = '저장';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'inline-edit-cancel';
  cancelBtn.textContent = '취소';

  const exitEdit = () => {
    row.classList.remove('is-editing');
    renderMessages();
  };

  saveBtn.addEventListener('click', async () => {
    const newText = textarea.value.trim();
    if (!newText) {
      showToast('메시지 내용을 입력하세요.', 'warning');
      return;
    }
    if (newText === originalContent) {
      exitEdit();
      return;
    }
    saveBtn.disabled = true;
    const ok = await saveEditedMessage(msg.message_id, newText);
    if (!ok) {
      saveBtn.disabled = false;
    } else {
      row.classList.remove('is-editing');
    }
  });

  cancelBtn.addEventListener('click', exitEdit);
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      exitEdit();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      saveBtn.click();
    }
  });

  btnGroup.append(cancelBtn, saveBtn);
  actionsBox.append(hint, btnGroup);
  editBox.append(textarea, actionsBox);

  bubble.replaceChildren(editBox);
  adjustHeight();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function getNumericMessageId(msg) {
  if (!msg || !msg.message_id) return 0;
  const num = parseInt(String(msg.message_id).replace(/\D/g, ''), 10);
  return Number.isNaN(num) ? 0 : num;
}

function findDmConv(userIdOrNick) {
  if (!userIdOrNick) return null;
  const str = String(userIdOrNick);
  if (conversations.has(str)) return conversations.get(str);
  const withoutPrefix = str.replace(/^dm:/, '');
  if (conversations.has(withoutPrefix)) return conversations.get(withoutPrefix);
  const num = parseInt(withoutPrefix, 10);
  for (const conv of conversations.values()) {
    if (conv.type === 'dm') {
      if (conv.name === withoutPrefix) return conv;
      if (conv.partnerUserId && Number(conv.partnerUserId) === num) return conv;
      const user = userDirectory.get(conv.name);
      if (user && Number(user.id) === num) {
        conv.partnerUserId = user.id;
        return conv;
      }
    }
  }
  return null;
}

function parseConvKey(convId) {
  const conv = conversations.get(convId) || findDmConv(convId);
  if (conv && conv.type === 'dm') {
    const partnerUser = userDirectory.get(conv.name);
    const partnerId = conv.partnerUserId || partnerUser?.id || conv.name;
    return { type: 'dm', id: String(partnerId), rawKey: `dm:${partnerId}`, nick: conv.name };
  }
  const str = String(convId);
  const parts = str.split(':');
  if (parts.length === 2) {
    return { type: parts[0], id: parts[1], rawKey: str };
  }
  if (str.startsWith('dm:')) {
    const id = str.slice(3);
    return { type: 'dm', id, rawKey: str };
  }
  return { type: 'channel', id: '1', rawKey: 'channel:1' };
}

function getConvUnreadCount(conv) {
  if (!conv) return 0;
  if (conv.id === activeConvId) return 0;
  if (conv.type === 'channel') {
    return userUnreadCounts.get(conv.id) ?? conv.unread ?? 0;
  }
  if (conv.type === 'dm') {
    const partnerId = conv.partnerUserId || userDirectory.get(conv.name)?.id;
    if (partnerId && userUnreadCounts.has(`dm:${partnerId}`)) {
      return userUnreadCounts.get(`dm:${partnerId}`);
    }
    if (userUnreadCounts.has(conv.id)) {
      return userUnreadCounts.get(conv.id);
    }
    if (userUnreadCounts.has(`dm:${conv.name}`)) {
      return userUnreadCounts.get(`dm:${conv.name}`);
    }
    return conv.unread ?? 0;
  }
  return 0;
}

function getConvState(convId) {
  const conv = conversations.get(convId) || findDmConv(convId);
  if (!conv) return userConversationStates.get(convId);
  if (conv.type === 'channel') {
    return userConversationStates.get(conv.id);
  }
  if (conv.type === 'dm') {
    const partnerId = conv.partnerUserId || userDirectory.get(conv.name)?.id;
    if (partnerId && userConversationStates.has(`dm:${partnerId}`)) {
      return userConversationStates.get(`dm:${partnerId}`);
    }
    return userConversationStates.get(conv.id) || userConversationStates.get(`dm:${conv.name}`);
  }
  return userConversationStates.get(convId);
}

let ackDebounceTimer = null;
function ackActiveConversationRead() {
  const conv = conversations.get(activeConvId);
  if (!conv || !currentUser) return;
  
  let maxId = 0;
  for (const m of conv.messages) {
    const num = getNumericMessageId(m);
    if (num > maxId) maxId = num;
  }
  
  if (maxId <= 0) return;
  
  const parsed = parseConvKey(activeConvId);
  const state = getConvState(activeConvId);
  const prevLastRead = state?.last_read_message_id || 0;
  if (maxId <= prevLastRead) return;

  const updatedState = {
    ...(state || {}),
    conversation_type: parsed.type,
    conversation_id: parsed.id,
    last_read_message_id: maxId,
    muted: Boolean(state?.muted),
  };
  userConversationStates.set(parsed.rawKey, updatedState);
  userConversationStates.set(activeConvId, updatedState);
  userUnreadCounts.set(parsed.rawKey, 0);
  userUnreadCounts.set(activeConvId, 0);
  conv.unread = 0;
  renderConversationList();

  clearTimeout(ackDebounceTimer);
  ackDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/read-states/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_type: parsed.type,
          conversation_id: parsed.id,
          last_read_message_id: maxId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.unread_counts) {
        Object.entries(data.unread_counts).forEach(([k, v]) => {
          userUnreadCounts.set(k, v);
          const c = findDmConv(k) || conversations.get(k);
          if (c) {
            if (c.id === activeConvId) {
              c.unread = 0;
              userUnreadCounts.set(k, 0);
              userUnreadCounts.set(c.id, 0);
            } else {
              c.unread = v;
              userUnreadCounts.set(c.id, v);
            }
          }
        });
        renderConversationList();
      }
    } catch { /* network err */ }
  }, 200);
}

async function toggleActiveConvMute() {
  const conv = conversations.get(activeConvId);
  if (!conv || !currentUser) return;
  const parsed = parseConvKey(activeConvId);
  const state = getConvState(activeConvId);
  const newMuted = !Boolean(state?.muted);
  
  const updatedState = {
    ...(state || {}),
    conversation_type: parsed.type,
    conversation_id: parsed.id,
    last_read_message_id: state?.last_read_message_id || 0,
    muted: newMuted,
  };
  userConversationStates.set(parsed.rawKey, updatedState);
  userConversationStates.set(activeConvId, updatedState);
  updateMuteButtonUI();
  renderConversationList();

  try {
    const res = await fetch('/api/read-states/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_type: parsed.type,
        conversation_id: parsed.id,
        muted: newMuted,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || '음소거 설정에 실패했습니다.');
    showToast(newMuted ? '대화방 알림을 껐습니다 (음소거).' : '대화방 알림을 켰습니다.', 'info');
  } catch (err) {
    showToast(err.message || '음소거 설정에 실패했습니다.', 'error');
  }
}

function updateMuteButtonUI() {
  if (!convMuteBtn) return;
  const state = getConvState(activeConvId);
  const isMuted = Boolean(state?.muted);
  convMuteBtn.textContent = isMuted ? '🔕' : '🔔';
  convMuteBtn.title = isMuted ? '알림 설정 (음소거됨)' : '알림 설정 (켜짐)';
  convMuteBtn.setAttribute('aria-label', isMuted ? '알림 설정 (음소거됨)' : '알림 설정 (켜짐)');
  convMuteBtn.classList.toggle('is-muted', isMuted);
}

let muteHintTimer = null;
function hideMuteHint() {
  if (muteHintTimer) {
    clearTimeout(muteHintTimer);
    muteHintTimer = null;
  }
  if (muteHintPopover) {
    muteHintPopover.classList.add('hidden');
  }
}

function showMuteHint() {
  if (!muteHintPopover) return;
  if (muteHintTimer) clearTimeout(muteHintTimer);
  const isMuted = Boolean(getConvState(activeConvId)?.muted);
  if (muteHintIcon) muteHintIcon.textContent = isMuted ? '🔕' : '💡';
  if (muteHintTitle) muteHintTitle.textContent = isMuted ? '알림 음소거 상태' : '알림 설정 가능!';
  if (muteHintDesc) muteHintDesc.textContent = isMuted ? '여기를 클릭해 음소거를 해제할 수 있습니다' : '여기를 클릭해 대화방 알림을 끄거나 켤 수 있습니다';
  muteHintPopover.classList.remove('hidden');
  muteHintTimer = setTimeout(() => {
    hideMuteHint();
  }, 6000);
}

// --- Global Sound Preferences & Web Audio Synthesizer ---
let audioCtx = null;
let lastSoundTime = 0;
const SOUND_THROTTLE_MS = 500;

function getSoundModeKey() {
  return currentUser ? `bamboochat_sound_mode_${currentUser.id}` : 'bamboochat_sound_mode';
}

function getSoundVolumeKey() {
  return currentUser ? `bamboochat_sound_volume_${currentUser.id}` : 'bamboochat_sound_volume';
}

function getDesktopNotifKey() {
  return currentUser ? `bamboochat_desktop_notif_${currentUser.id}` : 'bamboochat_desktop_notif';
}

function getSnoozeKey() {
  return currentUser ? `bamboochat_snooze_until_${currentUser.id}` : 'bamboochat_snooze_until';
}

function getSoundMode() {
  try {
    return localStorage.getItem(getSoundModeKey()) || 'important';
  } catch {
    return 'important';
  }
}

function setSoundMode(mode) {
  try {
    localStorage.setItem(getSoundModeKey(), mode);
  } catch { /* storage */ }
}

function getSoundVolume() {
  try {
    const raw = localStorage.getItem(getSoundVolumeKey());
    return raw !== null ? Math.max(0, Math.min(1, parseFloat(raw))) : 0.5;
  } catch {
    return 0.5;
  }
}

function setSoundVolume(volume) {
  try {
    localStorage.setItem(getSoundVolumeKey(), String(Math.max(0, Math.min(1, volume))));
  } catch { /* storage */ }
}

function isDesktopNotificationEnabled() {
  try {
    return localStorage.getItem(getDesktopNotifKey()) === 'enabled';
  } catch {
    return false;
  }
}

function setDesktopNotificationEnabled(enabled) {
  try {
    localStorage.setItem(getDesktopNotifKey(), enabled ? 'enabled' : 'disabled');
  } catch { /* storage */ }
}

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playNotificationSound(overrideThrottle = false) {
  const now = Date.now();
  if (!overrideThrottle && (now - lastSoundTime < SOUND_THROTTLE_MS)) return;
  lastSoundTime = now;

  const volume = getSoundVolume();
  if (volume <= 0) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(volume * 0.15, ctx.currentTime);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();

    osc1.type = 'sine';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08); // A5

    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
    osc2.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.16); // D6

    osc1.connect(gainNode);
    osc2.connect(gainNode);

    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.12);

    osc2.start(ctx.currentTime + 0.08);
    osc2.stop(ctx.currentTime + 0.35);
  } catch {
    // Suppressed audio playback
  }
}

// --- Snooze Management ---
function getSnoozeUntil() {
  if (!currentUser) return 0;
  try {
    const raw = localStorage.getItem(getSnoozeKey());
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function isSnoozed() {
  const until = getSnoozeUntil();
  if (!until) return false;
  if (Date.now() >= until) {
    clearSnooze();
    return false;
  }
  return true;
}

function setSnooze(durationMinutes) {
  let until = 0;
  const now = Date.now();
  if (durationMinutes === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    until = d.getTime();
  } else {
    const mins = Number(durationMinutes) || 15;
    until = now + mins * 60 * 1000;
  }
  try {
    localStorage.setItem(getSnoozeKey(), String(until));
  } catch { /* storage */ }
  updateNotificationSettingsUI();
}

function clearSnooze() {
  try {
    localStorage.removeItem(getSnoozeKey());
  } catch { /* storage */ }
  updateNotificationSettingsUI();
}

function formatSnoozeRemaining(untilMs) {
  const diffMs = untilMs - Date.now();
  if (diffMs <= 0) return '종료됨';
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}분 남음`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}시간 ${remMins}분 남음` : `${hours}시간 남음`;
}

// --- Browser Title Unread Counter ---
function getTotalUnreadCount() {
  if (!currentUser) return 0;
  let total = 0;
  const processedDms = new Set();

  conversations.forEach(conv => {
    if (conv.type === 'dm') {
      const partnerId = conv.partnerUserId || userDirectory.get(conv.name)?.id || conv.name;
      processedDms.add(String(partnerId));
      processedDms.add(String(conv.name));
    }
    total += getConvUnreadCount(conv);
  });

  userUnreadCounts.forEach((val, key) => {
    if (val <= 0) return;
    if (key.startsWith('channel:')) {
      if (!conversations.has(key)) {
        total += val;
      }
    } else if (key.startsWith('dm:')) {
      const idOrNick = key.slice(3);
      if (!processedDms.has(idOrNick)) {
        processedDms.add(idOrNick);
        total += val;
      }
    }
  });

  return total;
}

function updateDocumentTitle() {
  if (!currentUser) {
    document.title = 'BambooChat';
    return;
  }
  const total = getTotalUnreadCount();
  document.title = total > 0 ? `(${total}) BambooChat` : 'BambooChat';
}

// --- Desktop Notifications ---
function checkDesktopNotificationContext() {
  const isSecure = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
  const hasSupport = 'Notification' in window;
  let permission = 'unsupported';
  if (hasSupport) {
    try {
      permission = Notification.permission;
    } catch {
      permission = 'unsupported';
    }
  }
  return { isSecure, hasSupport, permission };
}

function showDesktopNotification({ title, body, conversationId }) {
  if (!isDesktopNotificationEnabled()) return;
  const { hasSupport, permission } = checkDesktopNotificationContext();
  if (!hasSupport || permission !== 'granted') return;

  try {
    const notif = new Notification(title || 'BambooChat', {
      body: body || '',
      icon: '/favicon.ico',
      tag: conversationId || 'bamboochat-msg',
    });
    notif.onclick = () => {
      window.focus();
      if (conversationId) {
        switchConversation(conversationId);
      }
      notif.close();
    };
  } catch {
    // Suppressed or failed
  }
}

// --- Shared Attention Adapter ---
function emitAttention({
  kind = 'ordinary', // 'dm' | 'mention' | 'reply' | 'ordinary'
  conversationId = null,
  title = '',
  body = '',
  isHistory = false,
  isOwnMessage = false,
  senderNick = '',
}) {
  if (isOwnMessage) return;
  if (isHistory) return;

  const isCurrentActive = Boolean(conversationId && conversationId === activeConvId);
  const convState = conversationId ? getConvState(conversationId) : null;
  const isMuted = Boolean(convState?.muted);
  const snoozed = isSnoozed();

  if (isCurrentActive) return;
  if (isMuted || snoozed) return;

  const isImportant = (kind === 'dm' || kind === 'mention' || kind === 'reply');

  // Harmless future desktop-wrapper hook (executed only for active, unmuted, unsnoozed important alerts)
  if (isImportant) {
    try {
      window.bambooDesktop?.requestAttention?.({
        kind,
        conversationId,
      });
    } catch { /* ignore */ }
  }

  const soundMode = getSoundMode();

  if (soundMode === 'all' || (soundMode === 'important' && isImportant)) {
    playNotificationSound();
  }

  if (title || body) {
    const toastTone = (kind === 'mention' || kind === 'reply') ? 'mention' : 'info';
    const toastMsg = title ? `${title}: ${body}` : body;
    showToast(toastMsg, toastTone);
  }

  if (isImportant && isDesktopNotificationEnabled()) {
    showDesktopNotification({ title, body, conversationId });
  }
}

// --- Notification Modal UI Sync ---
function updateNotificationSettingsUI() {
  if (!currentUser) return;

  // 1. Current Conversation Mute Section
  const conv = conversations.get(activeConvId);
  if (conv && notifConvSection) {
    notifConvSection.classList.remove('hidden');
    const isMuted = Boolean(getConvState(activeConvId)?.muted);
    const displayName = conv.type === 'channel' ? `#${conv.displayName || conv.name}` : `${displayNickname(conv.name)}`;

    if (notificationModalDesc) notificationModalDesc.textContent = `${displayName} 및 전체 알림 환경을 설정합니다.`;
    if (notificationStatusIcon) notificationStatusIcon.textContent = isMuted ? '🔕' : '🔔';
    if (notificationStatusTitle) notificationStatusTitle.textContent = isMuted ? '현재 상태: 알림 음소거됨 (🔕)' : '현재 상태: 알림 켜짐 (🔔)';
    if (notificationStatusDesc) notificationStatusDesc.textContent = isMuted
      ? `${displayName}의 새 메시지 도착 시 소리 및 팝업 알림이 표시되지 않습니다.`
      : `${displayName}에 새 메시지가 도착하면 알림이 정상적으로 표시됩니다.`;
    if (notificationToggleBtn) {
      notificationToggleBtn.textContent = isMuted ? '알림 켜기 (음소거 해제)' : '알림 끄기 (음소거)';
      notificationToggleBtn.className = isMuted ? 'primary-btn notif-toggle-action-btn' : 'caution-btn notif-toggle-action-btn';
    }
  } else if (notifConvSection) {
    notifConvSection.classList.add('hidden');
    if (notificationModalDesc) notificationModalDesc.textContent = '전체 알림 및 소리 환경을 설정합니다.';
  }

  // 2. Sound Mode & Volume
  const currentSoundMode = getSoundMode();
  soundModeInputs.forEach(input => {
    input.checked = input.value === currentSoundMode;
  });

  const vol = getSoundVolume();
  if (soundVolumeSlider) soundVolumeSlider.value = String(Math.round(vol * 100));
  if (soundVolumeVal) soundVolumeVal.textContent = `${Math.round(vol * 100)}%`;

  // 3. Desktop Notifications Context
  const { isSecure, hasSupport, permission } = checkDesktopNotificationContext();
  const enabled = isDesktopNotificationEnabled();

  if (desktopNotifStatusBadge) {
    desktopNotifStatusBadge.className = 'notif-badge';
    if (!hasSupport) {
      desktopNotifStatusBadge.textContent = '브라우저 미지원';
    } else if (permission === 'denied') {
      desktopNotifStatusBadge.textContent = '권한 차단됨';
      desktopNotifStatusBadge.classList.add('denied');
    } else if (permission === 'granted') {
      desktopNotifStatusBadge.textContent = enabled ? '활성화됨 (허용됨)' : '꺼짐 (권한 허용됨)';
      if (enabled) desktopNotifStatusBadge.classList.add('granted');
    } else {
      desktopNotifStatusBadge.textContent = '권한 필요';
    }
  }

  if (desktopNotifToggleBtn) {
    if (!hasSupport) {
      desktopNotifToggleBtn.disabled = true;
      desktopNotifToggleBtn.textContent = '지원하지 않음';
    } else if (permission === 'denied') {
      desktopNotifToggleBtn.disabled = true;
      desktopNotifToggleBtn.textContent = '브라우저에서 차단됨';
    } else if (permission === 'granted') {
      desktopNotifToggleBtn.disabled = false;
      desktopNotifToggleBtn.textContent = enabled ? '데스크톱 알림 끄기' : '데스크톱 알림 켜기';
      desktopNotifToggleBtn.className = enabled ? 'caution-btn' : 'primary-btn';
    } else {
      desktopNotifToggleBtn.disabled = false;
      desktopNotifToggleBtn.textContent = '데스크톱 알림 허용하기';
      desktopNotifToggleBtn.className = 'primary-btn';
    }
  }

  if (desktopNotifHint) {
    desktopNotifHint.classList.toggle('hidden', isSecure);
  }

  // 4. Snooze Status
  const snoozed = isSnoozed();
  const until = getSnoozeUntil();
  if (snoozeStatusBadge) {
    snoozeStatusBadge.className = `snooze-badge ${snoozed ? 'active' : 'inactive'}`;
    snoozeStatusBadge.textContent = snoozed ? `방해 금지 중 (${formatSnoozeRemaining(until)})` : '알림 수신 중';
  }
  if (snoozeResumeBtn) {
    snoozeResumeBtn.classList.toggle('hidden', !snoozed);
  }
  snoozeButtons.forEach(btn => {
    btn.classList.toggle('active', false);
  });
}

function openNotificationModal() {
  hideNotifHint();
  hideMuteHint();
  if (!currentUser) return;
  updateNotificationSettingsUI();
  if (notificationModal) notificationModal.classList.remove('hidden');
}

function closeNotificationModal() {
  if (notificationModal) notificationModal.classList.add('hidden');
  if (currentUser) msgInput.focus();
}

if (convMuteBtn) {
  convMuteBtn.addEventListener('click', openNotificationModal);
}
if (headerNotifBtn) {
  headerNotifBtn.addEventListener('click', openNotificationModal);
}
if (notifHintClose) {
  notifHintClose.addEventListener('click', event => {
    event.stopPropagation();
    hideNotifHint();
  });
}
if (notifHintPopover) {
  notifHintPopover.addEventListener('click', () => {
    hideNotifHint();
    openNotificationModal();
  });
}
if (notificationToggleBtn) {
  notificationToggleBtn.addEventListener('click', async () => {
    await toggleActiveConvMute();
    updateNotificationSettingsUI();
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
    if (soundVolumeVal) soundVolumeVal.textContent = `${soundVolumeSlider.value}%`;
  });
}
if (soundTestBtn) {
  soundTestBtn.addEventListener('click', () => {
    playNotificationSound(true);
  });
}
if (desktopNotifToggleBtn) {
  desktopNotifToggleBtn.addEventListener('click', async () => {
    const { hasSupport, permission } = checkDesktopNotificationContext();
    if (!hasSupport) return;

    if (permission === 'default') {
      try {
        const res = await Notification.requestPermission();
        if (res === 'granted') {
          setDesktopNotificationEnabled(true);
        }
      } catch { /* ignored */ }
    } else if (permission === 'granted') {
      setDesktopNotificationEnabled(!isDesktopNotificationEnabled());
    }
    updateNotificationSettingsUI();
  });
}
if (desktopNotifTestBtn) {
  desktopNotifTestBtn.addEventListener('click', async () => {
    const { hasSupport, permission } = checkDesktopNotificationContext();
    if (!hasSupport) {
      showToast('이 브라우저는 데스크톱 알림을 지원하지 않습니다.', 'warning');
      return;
    }
    if (permission === 'default') {
      try {
        const res = await Notification.requestPermission();
        if (res === 'granted') {
          setDesktopNotificationEnabled(true);
          updateNotificationSettingsUI();
          new Notification('BambooChat 테스트 알림 💬', {
            body: '데스크톱 알림이 정상적으로 작동하고 있습니다! 🎉',
            icon: '/favicon.ico',
          });
          showToast('데스크톱 테스트 알림을 발송했습니다.', 'success');
        } else {
          updateNotificationSettingsUI();
          showToast('알림 권한이 허용되지 않았습니다.', 'warning');
        }
      } catch {
        showToast('알림 권한 요청에 실패했습니다.', 'error');
      }
      return;
    }
    if (permission === 'denied') {
      showToast('브라우저 설정에서 알림 권한이 차단되어 있습니다.', 'error');
      return;
    }
    if (permission === 'granted') {
      try {
        new Notification('BambooChat 테스트 알림 💬', {
          body: '데스크톱 알림이 정상적으로 작동하고 있습니다! 🎉',
          icon: '/favicon.ico',
        });
        showToast('데스크톱 테스트 알림을 발송했습니다.', 'success');
      } catch (err) {
        showToast('알림 발송 실패: ' + (err.message || '권한 또는 환경 제한'), 'error');
      }
    }
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
  snoozeResumeBtn.addEventListener('click', () => {
    clearSnooze();
  });
}
if (notificationModalClose) notificationModalClose.addEventListener('click', closeNotificationModal);
if (notificationModalCancel) notificationModalCancel.addEventListener('click', closeNotificationModal);
if (notificationModal) {
  notificationModal.addEventListener('click', event => {
    if (event.target === notificationModal) closeNotificationModal();
  });
}
if (muteHintClose) {
  muteHintClose.addEventListener('click', event => {
    event.stopPropagation();
    hideMuteHint();
  });
}
if (muteHintPopover) {
  muteHintPopover.addEventListener('click', () => {
    hideMuteHint();
    openNotificationModal();
  });
}

const COLLAPSED_SECTIONS_KEY = 'bamboochat_collapsed_sections';

function loadCollapsedSections() {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistCollapsedSections(state) {
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

function applyCollapsedSections() {
  const state = loadCollapsedSections();
  document.querySelectorAll('.sidebar-section[data-section]').forEach(section => {
    const name = section.dataset.section;
    const isCollapsed = Boolean(state[name]);
    section.classList.toggle('collapsed', isCollapsed);
    const btn = section.querySelector('.section-toggle-btn');
    if (btn) btn.setAttribute('aria-expanded', String(!isCollapsed));
  });
}

document.querySelectorAll('.section-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const section = btn.closest('.sidebar-section');
    if (!section) return;
    const isCollapsed = section.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!isCollapsed));
    const name = section.dataset.section;
    if (name) {
      const state = loadCollapsedSections();
      if (isCollapsed) state[name] = true;
      else delete state[name];
      persistCollapsedSections(state);
    }
  });
});

sidebarToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarBackdrop.classList.toggle('hidden', !open);
});
sidebarBackdrop.addEventListener('click', closeSidebar);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (notificationModal && !notificationModal.classList.contains('hidden')) closeNotificationModal();
    else if (channelEditModal && !channelEditModal.classList.contains('hidden')) closeChannelEditModal();
    else if (!channelModal.classList.contains('hidden')) closeChannelModal();
    else if (!nicknameModal.classList.contains('hidden')) closeNicknameModal();
    else if (!helpModal.classList.contains('hidden')) closeHelpModal();
  }
});

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarToggle.setAttribute('aria-expanded', 'false');
  sidebarBackdrop.classList.add('hidden');
}

function saveCurrentDraft() {
  if (!conversations.has(activeConvId)) return;
  const value = msgInput.value;
  if (value) drafts[activeConvId] = value;
  else delete drafts[activeConvId];
  persistDrafts();
}

function loadActiveDraft() {
  msgInput.value = drafts[activeConvId] || '';
  resizeComposer();
  updateCharCount();
}

function updateLoadOlderButton() {
  const conv = conversations.get(activeConvId);
  const visible = Boolean(conv && conv.hasOlder);
  loadOlderBtn.classList.toggle('hidden', !visible);
  loadOlderBtn.disabled = Boolean(conv?.loadingOlder);
  loadOlderBtn.textContent = conv?.loadingOlder
    ? '이전 메시지 불러오는 중…'
    : '↑ 이전 메시지 더 불러오기';
}

async function fetchChannelMessages(conv) {
  if (!conv || conv.loadingOlder || conv.loaded) return;
  conv.loadingOlder = true;
  updateLoadOlderButton();
  try {
    const response = await fetch(`/api/channels/${conv.channelId}/messages`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '메시지를 불러오지 못했습니다.');
    const messages = (Array.isArray(data.messages) ? data.messages : []).map(publicMessageFromData);
    conv.messages = messages;
    conv.messageIds = new Set(messages.map(m => m.message_id).filter(Boolean));
    conv.hasOlder = Boolean(data.has_more);
    conv.loaded = true;
    if (conv.id === activeConvId) {
      renderMessages();
      scrollBottom();
      ackActiveConversationRead();
    }
  } catch (err) {
    showToast(err.message || '채널 메시지를 불러오지 못했습니다.', 'error');
  } finally {
    conv.loadingOlder = false;
    updateLoadOlderButton();
  }
}

function switchConversation(id) {
  if (!conversations.has(id)) return;
  saveCurrentDraft();
  activeConvId = id;
  closeMentionMenu();
  const conv = conversations.get(id);
  conv.unread = 0;
  userUnreadCounts.set(id, 0);
  const parsed = parseConvKey(id);
  if (parsed.rawKey) userUnreadCounts.set(parsed.rawKey, 0);
  const isAdmin = currentUser && currentUser.role === 'admin';
  if (channelSettingsBtn) {
    channelSettingsBtn.classList.toggle('hidden', !(conv.type === 'channel' && isAdmin));
  }
  updateMuteButtonUI();
  if (conv.type === 'channel') {
    const displayName = conv.displayName || conv.name;
    chatAreaTitle.textContent = `# ${displayName}`;
    if (chatAreaDesc) chatAreaDesc.textContent = conv.description || '';
    retentionNote.textContent = '⚠️ HTTP LAN · 암호화되지 않음 · 민감정보 공유 금지';
    retentionNote.classList.remove('dm-warning');
    msgInput.placeholder = `# ${displayName}에 메시지 입력`;
    if (!conv.loaded && conv.channelId !== 1) {
      fetchChannelMessages(conv);
    }
  } else {
    const displayName = displayNickname(conv.name, conv.ipSuffix);
    chatAreaTitle.textContent = `💬 ${displayName}`;
    if (chatAreaDesc) chatAreaDesc.textContent = '';
    retentionNote.textContent = '⚠️ HTTP LAN · 암호화되지 않음 · 민감정보 공유 금지';
    retentionNote.classList.add('dm-warning');
    msgInput.placeholder = `${displayName}에게 DM 보내기`;
  }
  loadActiveDraft();
  renderComposerPreviews();
  renderMessages();
  ackActiveConversationRead();
  renderConversationList();
  updateLoadOlderButton();
  closeSidebar();
  msgInput.focus();
}

function makeKeyboardClickable(element, callback) {
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  });
}

function renderConversationList() {
  if (channelListEl) channelListEl.replaceChildren();
  if (dmListEl) dmListEl.replaceChildren();
  if (convListEl && !channelListEl) convListEl.replaceChildren();

  // 1. Render Channels: default channel pinned at top, other channels sorted by recent message activity
  const channelConvs = [...conversations.values()]
    .filter(conv => conv.type === 'channel')
    .sort((a, b) => {
      const isDefA = Boolean(a.isDefault) || a.channelId === 1;
      const isDefB = Boolean(b.isDefault) || b.channelId === 1;
      if (isDefA && !isDefB) return -1;
      if (!isDefA && isDefB) return 1;
      const timeA = a.lastActivityTime || 0;
      const timeB = b.lastActivityTime || 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.channelId - b.channelId;
    });

  for (const conv of channelConvs) {
    const item = document.createElement('li');
    item.className = `conv-item channel-item${conv.id === activeConvId ? ' active' : ''}`;
    item.dataset.id = conv.id;
    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = '#';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = conv.displayName || conv.name;
    item.append(icon, name);

    const state = getConvState(conv.id);
    if (state?.muted) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'conv-mute-indicator';
      muteIcon.textContent = '🔕';
      muteIcon.title = '음소거됨';
      item.appendChild(muteIcon);
    }

    const unreadCount = getConvUnreadCount(conv);
    if (unreadCount > 0 && conv.id !== activeConvId) {
      const badge = document.createElement('span');
      badge.className = 'conv-unread';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      item.appendChild(badge);
    }
    const activate = () => switchConversation(conv.id);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    if (channelListEl) channelListEl.appendChild(item);
    else if (convListEl) convListEl.appendChild(item);
  }

  // 2. Render DMs: sorted by recent message activity
  const dmConvs = [...conversations.values()]
    .filter(conv => conv.type === 'dm')
    .sort((a, b) => {
      const timeA = a.lastActivityTime || 0;
      const timeB = b.lastActivityTime || 0;
      if (timeB !== timeA) return timeB - timeA;
      return String(a.name).localeCompare(String(b.name));
    });
  for (const conv of dmConvs) {
    const item = document.createElement('li');
    item.className = `conv-item dm-item${conv.id === activeConvId ? ' active' : ''}`;
    item.dataset.id = conv.id;
    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = '👤';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = displayNickname(conv.name);
    item.append(icon, name);

    const state = getConvState(conv.id);
    if (state?.muted) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'conv-mute-indicator';
      muteIcon.textContent = '🔕';
      muteIcon.title = '음소거됨';
      item.appendChild(muteIcon);
    }

    const unreadCount = getConvUnreadCount(conv);
    if (unreadCount > 0 && conv.id !== activeConvId) {
      const badge = document.createElement('span');
      badge.className = 'conv-unread dm-unread';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      item.appendChild(badge);
    }
    const activate = () => switchConversation(conv.id);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    if (dmListEl) dmListEl.appendChild(item);
    else if (convListEl) convListEl.appendChild(item);
  }
  updateDocumentTitle();
}

function renderOnlineList(users) {
  const sortedUsers = [...users].sort((first, second) =>
    Number(Boolean(second.online)) - Number(Boolean(first.online))
      || String(first.username || first.nickname).localeCompare(String(second.username || second.nickname))
  );
  onlineCountEl.textContent = String(sortedUsers.filter(user => user.online).length);
  userCountEl.textContent = String(sortedUsers.length);
  onlineListEl.replaceChildren();
  sortedUsers.forEach(user => {
    const nick = user.username || user.nickname;
    const displayName = user.display_name || displayNickname(nick);
    const online = Boolean(user.online);
    const item = document.createElement('li');
    item.className = `online-item${online ? '' : ' offline'}`;
    const dot = document.createElement('span');
    dot.className = `online-dot${online ? '' : ' offline'}`;
    const nickElement = document.createElement('span');
    nickElement.className = `online-nick${nick === myNickname ? ' is-me' : ''}`;
    nickElement.textContent = displayName + (nick === myNickname ? ' (나)' : '');
    item.setAttribute('aria-label', `${displayName} ${online ? '온라인' : '오프라인'}`);
    item.title = `${displayName} (@${nick}) — ${online ? '온라인' : '오프라인'}`;
    item.append(dot, nickElement);
    if (nick !== myNickname && online) {
      const openDm = () => {
        getOrCreateDm(nick, user.id);
        renderConversationList();
        switchConversation(nick);
      };
      const dmButton = document.createElement('button');
      dmButton.type = 'button';
      dmButton.className = 'online-dm-btn';
      dmButton.textContent = 'DM →';
      dmButton.title = `${displayName}님과 DM 열기`;
      dmButton.setAttribute('aria-label', `${displayName}님과 DM 열기`);
      dmButton.addEventListener('click', event => {
        event.stopPropagation();
        openDm();
      });
      item.appendChild(dmButton);
      item.addEventListener('click', openDm);
      makeKeyboardClickable(item, openDm);
    }
    onlineListEl.appendChild(item);
  });
}

function getMentionContext() {
  const conv = conversations.get(activeConvId);
  if (!conv || conv.type !== 'channel' || msgInput.selectionStart !== msgInput.selectionEnd) return null;
  const caret = msgInput.selectionStart;
  const beforeCaret = msgInput.value.slice(0, caret);
  const match = beforeCaret.match(/(^|[^\p{L}\p{N}._@-])@([\p{L}\p{N}._-]*)$/u);
  if (!match) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}

function closeMentionMenu() {
  mentionMenu.classList.add('hidden');
  mentionMenu.replaceChildren();
  mentionMatches = [];
  mentionRange = null;
  mentionActiveIndex = 0;
}

function setMentionActiveIndex(index) {
  if (!mentionMatches.length) return;
  mentionActiveIndex = (index + mentionMatches.length) % mentionMatches.length;
  [...mentionMenu.children].forEach((item, itemIndex) => {
    const selected = itemIndex === mentionActiveIndex;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
    if (selected) item.scrollIntoView({ block: 'nearest' });
  });
}

function selectMention(user = mentionMatches[mentionActiveIndex]) {
  if (!user || !mentionRange) return;
  const before = msgInput.value.slice(0, mentionRange.start);
  const after = msgInput.value.slice(mentionRange.end);
  const inserted = `@${user.username} `;
  msgInput.value = before + inserted + after;
  const caret = before.length + inserted.length;
  msgInput.setSelectionRange(caret, caret);
  closeMentionMenu();
  msgInput.dispatchEvent(new Event('input', { bubbles: true }));
  msgInput.focus();
}

function updateMentionMenu() {
  const context = getMentionContext();
  if (!context || !mentionUsers.length) {
    closeMentionMenu();
    return;
  }
  const query = context.query.toLocaleLowerCase();
  mentionRange = context;
  mentionMatches = mentionUsers.filter(user => {
    if (Number(user.id) === myUserId) return false;
    const username = String(user.username || '').toLocaleLowerCase();
    const displayName = String(user.display_name || '').toLocaleLowerCase();
    return username.startsWith(query) || displayName.startsWith(query);
  });
  if (!mentionMatches.length) {
    closeMentionMenu();
    return;
  }
  mentionActiveIndex = Math.min(mentionActiveIndex, mentionMatches.length - 1);
  mentionMenu.replaceChildren();
  mentionMatches.forEach((user, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `mention-option${index === mentionActiveIndex ? ' active' : ''}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === mentionActiveIndex));
    const nameLabel = document.createElement('span');
    const userDisplayName = user.display_name || user.username;
    nameLabel.textContent = userDisplayName !== user.username
      ? `${userDisplayName} (@${user.username})`
      : `@${user.username}`;
    const presence = document.createElement('span');
    presence.className = `mention-presence${user.online ? ' online' : ''}`;
    presence.textContent = user.online ? '온라인' : '오프라인';
    option.append(nameLabel, presence);
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => selectMention(user));
    mentionMenu.appendChild(option);
  });
  mentionMenu.classList.remove('hidden');
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === new Date().toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return today ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function validLink(href) {
  try {
    const url = new URL(href, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function appendInlineMarkdown(parent, source) {
  const pattern = /(\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    let node;
    if (match[2] !== undefined) {
      node = document.createElement('strong');
      node.textContent = match[2];
    } else if (match[3] !== undefined) {
      node = document.createElement('del');
      node.textContent = match[3];
    } else if (match[4] !== undefined) {
      node = document.createElement('code');
      node.textContent = match[4];
    } else if (match[5] !== undefined) {
      const url = validLink(match[6]);
      if (url) {
        node = document.createElement('a');
        node.href = url.href;
        node.textContent = match[5];
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      } else {
        node = document.createTextNode(match[0]);
      }
    } else {
      node = document.createElement('em');
      node.textContent = match[7];
    }
    parent.appendChild(node);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

function appendParagraph(container, lines) {
  const paragraph = document.createElement('p');
  lines.forEach((line, index) => {
    if (index) paragraph.appendChild(document.createElement('br'));
    appendInlineMarkdown(paragraph, line);
  });
  container.appendChild(paragraph);
}

function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || '').split('\n');
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    if (lines[index].trimStart().startsWith('```')) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy-btn';
      copy.textContent = '복사';
      copy.addEventListener('click', () => copyText(codeLines.join('\n'), '코드를 복사했습니다.'));
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      wrapper.append(copy, pre);
      container.appendChild(wrapper);
      continue;
    }
    if (/^\s*[-+•]\s+/.test(lines[index])) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-+•]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*[-+•]\s+/, ''));
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    if (/^\s*>\s?/.test(lines[index])) {
      const quote = document.createElement('blockquote');
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      appendParagraph(quote, quoteLines);
      container.appendChild(quote);
      continue;
    }
    const paragraphLines = [];
    while (
      index < lines.length && lines[index].trim() &&
      !lines[index].trimStart().startsWith('```') &&
      !/^\s*[-+•]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(container, paragraphLines);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMentions(container, mentions) {
  const usernames = (Array.isArray(mentions) ? mentions : [])
    .map(mention => String(mention.username || ''))
    .filter(Boolean)
    .sort((first, second) => second.length - first.length);
  if (!usernames.length) return;
  const names = usernames.map(escapeRegExp).join('|');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}._-])(@(?:${names}))(?![\\p{L}\\p{N}._-])`, 'giu');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('code, a')) textNodes.push(node);
  }
  textNodes.forEach(textNode => {
    const source = textNode.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(source)) return;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index > cursor) fragment.append(source.slice(cursor, match.index));
      if (match[1]) fragment.append(match[1]);
      const mention = document.createElement('span');
      mention.className = 'message-mention';
      mention.textContent = match[2];
      fragment.appendChild(mention);
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    textNode.replaceWith(fragment);
  });
}

function createReplyQuote(reply) {
  if (!reply) return null;
  const quote = document.createElement('div');
  quote.className = 'message-reply-quote';
  const name = document.createElement('strong');
  name.textContent = reply.nickname || '메시지';
  const text = document.createElement('span');
  text.textContent = reply.content || '첨부 파일';
  quote.append(name, text);
  return quote;
}

function normaliseMessageAttachments(msg) {
  if (Array.isArray(msg.attachments)) return msg.attachments;
  if (msg.attachment) return [msg.attachment];
  if (msg.attachment_removed) return [{ id: 'removed', name: '파일', removed: true }];
  return [];
}

function createAttachmentRemovedNotice(attachment) {
  const notice = document.createElement('div');
  notice.className = 'attachment-removed';
  notice.setAttribute('role', 'status');
  notice.textContent = `🗑️ ${attachment.name || '파일'} · 업로더가 삭제함`;
  return notice;
}

function createAttachmentEntry(attachment) {
  const entry = document.createElement('div');
  entry.className = 'attachment-entry';
  if (attachment.removed) {
    entry.appendChild(createAttachmentRemovedNotice(attachment));
    return entry;
  }

  const card = document.createElement('a');
  card.className = `attachment-card${attachment.previewable ? ' image-attachment' : ''}`;
  card.href = attachment.url;
  card.target = '_blank';
  card.rel = 'noopener';
  if (!attachment.previewable) card.download = attachment.name;
  if (attachment.previewable) {
    const image = document.createElement('img');
    image.src = attachment.url;
    image.alt = attachment.name;
    image.loading = 'lazy';
    card.appendChild(image);
  }
  const icon = document.createElement('span');
  icon.className = 'attachment-icon';
  icon.textContent = attachment.previewable ? '🖼️' : '📄';
  const info = document.createElement('span');
  info.className = 'attachment-info';
  const name = document.createElement('strong');
  name.textContent = attachment.name;
  const meta = document.createElement('small');
  meta.textContent = `${formatBytes(attachment.size)} · SHA-256 ${attachment.sha256.slice(0, 12)}…`;
  info.append(name, meta);
  card.append(icon, info);
  entry.appendChild(card);

  if (Number(attachment.owner_id) === myUserId || currentUser?.role === 'admin') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-delete-btn';
    remove.textContent = '파일 삭제';
    remove.setAttribute('aria-label', `${attachment.name} 삭제`);
    remove.addEventListener('click', () => deleteOwnedAttachment(attachment.id));
    entry.appendChild(remove);
  }
  return entry;
}

function messageAuthor(msg) {
  if (msg.msgType === 'chat') return msg.nickname;
  return msg.from_nick;
}

function replySummary(msg) {
  const firstAttachment = normaliseMessageAttachments(msg)[0];
  return {
    nickname: messageAuthor(msg) || '메시지',
    content: (msg.content || firstAttachment?.name || '첨부 파일').slice(0, 180),
  };
}

function applyAttachmentDeleted(attachmentId) {
  let changed = false;
  for (const conversation of conversations.values()) {
    for (const message of conversation.messages) {
      const attachments = normaliseMessageAttachments(message);
      const target = attachments.find(attachment => attachment.id === attachmentId);
      if (!target || target.removed) continue;
      target.removed = true;
      delete target.url;
      delete target.size;
      delete target.sha256;
      delete target.content_type;
      delete target.previewable;
      message.attachments = attachments;
      message.attachment = attachments.find(attachment => !attachment.removed) || null;
      message.attachment_removed = attachments.length > 0 && !message.attachment;
      changed = true;
    }
  }
  if (changed) renderMessages();
}

async function deleteOwnedAttachment(attachmentId) {
  if (!window.confirm('파일만 삭제할까요? 채팅 메시지는 그대로 유지됩니다.')) return;

  try {
    const response = await fetch(`/api/files/${encodeURIComponent(attachmentId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).detail || ''; } catch { /* non-JSON error */ }
      throw new Error(detail || `파일 삭제 실패 (${response.status})`);
    }
    applyAttachmentDeleted(attachmentId);
    showToast('파일을 삭제해 업로드 용량을 확보했습니다.', 'success');
    refreshStorageWarning();
  } catch (error) {
    showToast(error.message || '파일을 삭제하지 못했습니다.', 'error');
  }
}

function createMessageActions(msg) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.textContent = '답장';
  replyButton.addEventListener('click', () => {
    replyTargets.set(activeConvId, replySummary(msg));
    renderComposerPreviews();
    msgInput.focus();
  });
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '복사';
  copyButton.addEventListener('click', () => copyText(msg.content || msg.attachment?.name || '', '메시지를 복사했습니다.'));
  actions.append(replyButton, copyButton);

  if (msg.msgType === 'chat' && msg.message_id) {
    const isAuthor = (msg.author_id != null && Number(msg.author_id) === myUserId) || msg.nickname === myNickname;
    const isAdmin = currentUser?.role === 'admin';
    if ((isAuthor || isAdmin) && !msg.is_hidden) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.textContent = '수정';
      editButton.addEventListener('click', () => {
        const row = document.querySelector(`.msg-row[data-message-id="${msg.message_id}"]`);
        if (row) enterInlineEditMode(row, msg);
      });
      actions.appendChild(editButton);
    }
    if (isAdmin) {
      const hideButton = document.createElement('button');
      hideButton.type = 'button';
      hideButton.textContent = msg.is_hidden ? '숨김 해제' : '숨김';
      hideButton.addEventListener('click', () => toggleMessageHidden(msg.message_id, !msg.is_hidden));
      actions.appendChild(hideButton);

      const moveButton = document.createElement('button');
      moveButton.type = 'button';
      moveButton.textContent = '이동';
      moveButton.addEventListener('click', () => openMoveMessageModal(msg));
      actions.appendChild(moveButton);
    }
  }

  return actions;
}

function minuteStamp(iso) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return '';
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()].join(':');
}

function sameMessageSender(first, second) {
  if (!first || !second || first.msgType !== second.msgType || first.msgType === 'system') return false;
  if (first.msgType === 'chat') {
    if (first.author_id != null && second.author_id != null) return Number(first.author_id) === Number(second.author_id);
    return first.nickname === second.nickname;
  }
  return first.from_nick === second.from_nick && first.to_nick === second.to_nick;
}

function messagesGroup(first, second) {
  return sameMessageSender(first, second)
    && minuteStamp(first.created_at) !== ''
    && minuteStamp(first.created_at) === minuteStamp(second.created_at);
}

function messageNeedsMyAttention(msg) {
  if (msg.msgType !== 'chat' || Number(msg.author_id) === myUserId) return false;
  const mentionsMe = Array.isArray(msg.mentioned_user_ids)
    && msg.mentioned_user_ids.some(id => Number(id) === myUserId);
  const repliesToMe = msg.reply && msg.reply.nickname === myNickname;
  return mentionsMe || repliesToMe;
}

function closeMessageActionMenus(exceptRow = null) {
  document.querySelectorAll('.msg-row.actions-open').forEach(openRow => {
    if (openRow === exceptRow) return;
    openRow.classList.remove('actions-open');
  });
}

function appendMessageNode(msg, previousMsg = null) {
  if (msg.msgType === 'system') {
    const row = document.createElement('div');
    row.className = 'msg-row system';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = msg.content;
    row.appendChild(bubble);
    messageListEl.appendChild(row);
    return;
  }

  const isChat = msg.msgType === 'chat';
  const isOwn = isChat ? msg.nickname === myNickname : msg.from_nick === myNickname;
  const grouped = messagesGroup(previousMsg, msg);
  const row = document.createElement('article');
  row.className = `msg-row ${isChat ? (isOwn ? 'own' : 'other') : (isOwn ? 'dm-own' : 'dm-recv')}${grouped ? ' grouped' : ''}`;
  if (messageNeedsMyAttention(msg)) row.classList.add('attention-for-me');
  if (msg.is_hidden) row.classList.add('hidden-msg');
  if (msg.message_id) row.dataset.messageId = msg.message_id;

  if (isChat && !grouped) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nick = document.createElement('span');
    nick.className = 'nick';
    const displayName = displayNickname(msg.nickname);
    nick.textContent = displayName;
    nick.title = displayName !== msg.nickname
      ? `${displayName} (@${msg.nickname})`
      : `@${msg.nickname}`;
    const time = document.createElement('time');
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    meta.append(nick, time);
    if (msg.is_hidden) {
      const hiddenBadge = document.createElement('span');
      hiddenBadge.className = 'msg-hidden-badge';
      hiddenBadge.textContent = '숨김 처리됨';
      meta.appendChild(hiddenBadge);
    }
    if (msg.moved_from_channel_id) {
      const fromChan = channelsDirectory.get(Number(msg.moved_from_channel_id));
      const movedBadge = document.createElement('span');
      movedBadge.className = 'msg-moved-badge';
      movedBadge.textContent = fromChan ? `#${fromChan.display_name}에서 이동됨` : '이동됨';
      meta.appendChild(movedBadge);
    }
    row.appendChild(meta);
  } else if (!isChat && !grouped) {
    const label = document.createElement('div');
    label.className = 'dm-label';
    const partnerNick = isOwn ? msg.to_nick : msg.from_nick;
    const displayName = displayNickname(partnerNick);
    label.textContent = displayName;
    label.title = displayName !== partnerNick
      ? `${displayName} (@${partnerNick})`
      : `@${partnerNick}`;
    const time = document.createElement('time');
    time.className = 'dm-time';
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    row.append(label, time);
  }

  const shell = document.createElement('div');
  shell.className = 'message-shell';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble markdown-body';
  const reply = createReplyQuote(msg.reply);
  if (reply) bubble.appendChild(reply);

  const isAdmin = currentUser?.role === 'admin';
  if (msg.is_hidden && !isAdmin) {
    const notice = document.createElement('div');
    notice.className = 'msg-hidden-notice';
    notice.textContent = '🔒 관리자에 의해 숨겨진 메시지입니다.';
    bubble.appendChild(notice);
  } else {
    if (msg.content) {
      const markdown = document.createElement('div');
      renderMarkdown(markdown, msg.content);
      highlightMentions(markdown, msg.mentions);
      if (msg.edited_at) {
        const editedBadge = document.createElement('span');
        editedBadge.className = 'msg-edited-badge';
        editedBadge.textContent = '(수정됨)';
        editedBadge.title = `수정일시: ${formatTime(msg.edited_at)}`;
        markdown.appendChild(editedBadge);
      }
      bubble.appendChild(markdown);
    }
    const attachments = normaliseMessageAttachments(msg);
    if (attachments.length) {
      const group = document.createElement('div');
      group.className = 'message-attachments';
      attachments.forEach(attachment => group.appendChild(createAttachmentEntry(attachment)));
      bubble.appendChild(group);
    }
  }

  const actions = createMessageActions(msg);
  bubble.addEventListener('click', event => {
    if (!window.matchMedia('(hover: none), (max-width: 640px)').matches) return;
    if (event.target.closest('a, button, textarea, input')) return;
    if (window.getSelection()?.toString()) return;
    event.stopPropagation();
    const willOpen = !row.classList.contains('actions-open');
    closeMessageActionMenus(row);
    row.classList.toggle('actions-open', willOpen);
  });
  actions.addEventListener('click', () => {
    row.classList.remove('actions-open');
  });
  shell.append(bubble, actions);
  row.appendChild(shell);
  messageListEl.appendChild(row);
}

function renderMessages(options = {}) {
  messageListEl.replaceChildren();
  const conv = conversations.get(activeConvId);
  if (!conv) return;

  if (conv.hasOlder) {
    messageListEl.appendChild(loadOlderBtn);
  }

  const state = userConversationStates.get(activeConvId);
  const lastReadId = state?.last_read_message_id || 0;
  let dividerInserted = false;

  conv.messages.forEach((message, index) => {
    const rawId = getNumericMessageId(message);
    if (!dividerInserted && lastReadId > 0 && rawId > lastReadId && index > 0) {
      const divider = document.createElement('div');
      divider.className = 'unread-divider';
      const label = document.createElement('span');
      label.textContent = '── 여기서부터 읽지 않은 메시지 ──';
      divider.appendChild(label);
      messageListEl.appendChild(divider);
      dividerInserted = true;
    }
    appendMessageNode(message, index > 0 ? conv.messages[index - 1] : null);
  });
  if (!options.preserveScroll) {
    scrollBottom();
  }
  ackActiveConversationRead();
}

function publicMessageFromData(data) {
  return {
    msgType: 'chat',
    message_id: data.message_id,
    nickname: data.nickname,
    author_id: data.author_id,
    channel_id: Number(data.channel_id || 1),
    content: data.content || '',
    created_at: data.created_at,
    edited_at: data.edited_at || null,
    is_hidden: Boolean(data.is_hidden),
    moved_from_channel_id: data.moved_from_channel_id || null,
    reply: data.reply || null,
    attachment: data.attachment || null,
    attachments: Array.isArray(data.attachments) ? data.attachments : null,
    attachment_removed: Boolean(data.attachment_removed),
    mentions: Array.isArray(data.mentions) ? data.mentions : [],
    mentioned_user_ids: Array.isArray(data.mentioned_user_ids) ? data.mentioned_user_ids : [],
  };
}

function directMessageFromData(data) {
  return {
    msgType: 'dm',
    message_id: data.message_id,
    from_nick: data.from_nick,
    from_user_id: data.from_user_id,
    to_nick: data.to_nick,
    to_user_id: data.to_user_id,
    content: data.content || '',
    created_at: data.created_at,
    reply: data.reply || null,
    attachment: data.attachment || null,
    attachments: Array.isArray(data.attachments) ? data.attachments : null,
    attachment_removed: Boolean(data.attachment_removed),
    edited_at: data.edited_at || null,
    is_hidden: Boolean(data.is_hidden),
  };
}

function prependMessages(conv, messages) {
  const fresh = messages.filter(message =>
    !message.message_id || !conv.messageIds.has(message.message_id)
  );
  fresh.forEach(message => {
    if (message.message_id) conv.messageIds.add(message.message_id);
  });
  conv.messages = [...fresh, ...conv.messages];
  return fresh.length;
}

function databaseMessageId(message) {
  const value = Number(String(message?.message_id || '').split(':')[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function loadOlderMessages() {
  const conv = conversations.get(activeConvId);
  if (!conv || conv.loadingOlder || !conv.hasOlder || !conv.messages.length) return;
  const beforeId = databaseMessageId(conv.messages[0]);
  if (!beforeId) {
    conv.hasOlder = false;
    updateLoadOlderButton();
    return;
  }
  conv.loadingOlder = true;
  updateLoadOlderButton();
  try {
    const path = conv.type === 'channel'
      ? `/api/channels/${conv.channelId}/messages`
      : `/api/history/dm/${encodeURIComponent(conv.name)}`;
    const response = await fetch(`${path}?before_id=${beforeId}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '이전 메시지를 불러오지 못했습니다.');
    const messages = (Array.isArray(data.messages) ? data.messages : []).map(item =>
      conv.type === 'channel' ? publicMessageFromData(item) : directMessageFromData(item)
    );
    const prevScrollHeight = messageListEl.scrollHeight;
    const prevScrollTop = messageListEl.scrollTop;
    prependMessages(conv, messages);
    conv.hasOlder = Boolean(data.has_more);
    if (conv.id === activeConvId) {
      renderMessages({ preserveScroll: true });
      const newScrollHeight = messageListEl.scrollHeight;
      messageListEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }
  } catch (error) {
    showToast(error.message || '이전 메시지를 불러오지 못했습니다.', 'error');
  } finally {
    conv.loadingOlder = false;
    updateLoadOlderButton();
  }
}

function addMessage(convId, msg, { markUnread = true } = {}) {
  const conv = conversations.get(convId);
  if (!conv) return false;
  if (msg.message_id && conv.messageIds.has(msg.message_id)) return false;
  if (msg.message_id) conv.messageIds.add(msg.message_id);
  const previousMsg = conv.messages.length ? conv.messages[conv.messages.length - 1] : null;
  conv.messages.push(msg);

  const msgTime = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();
  if (msgTime && (!conv.lastActivityTime || msgTime > conv.lastActivityTime)) {
    conv.lastActivityTime = msgTime;
  }

  if (convId === activeConvId) {
    appendMessageNode(msg, previousMsg);
    scrollBottom();
  } else if (markUnread) {
    conv.unread += 1;
    renderConversationList();
  }
  return true;
}

loadOlderBtn.addEventListener('click', loadOlderMessages);
document.addEventListener('click', event => {
  if (!event.target.closest('.msg-row.actions-open')) closeMessageActionMenus();
});

function addSystemMessage(convId, text) {
  addMessage(convId, { msgType: 'system', content: text });
}

function scrollBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function resizeComposer() {
  msgInput.style.height = 'auto';
  msgInput.style.height = `${Math.min(msgInput.scrollHeight, 156)}px`;
}

function updateCharCount() {
  charCount.textContent = `${msgInput.value.length} / ${MAX_MSG_LEN}`;
  charCount.classList.toggle('near-limit', msgInput.value.length > MAX_MSG_LEN * 0.9);
}

function getPendingAttachments(convId) {
  return pendingAttachments.get(convId) || [];
}

function renderComposerPreviews() {
  const reply = replyTargets.get(activeConvId);
  replyPreview.classList.toggle('hidden', !reply);
  if (reply) {
    replyPreviewName.textContent = `↩ ${reply.nickname}`;
    replyPreviewText.textContent = reply.content;
  }

  const states = getPendingAttachments(activeConvId);
  attachmentPreview.classList.toggle('hidden', states.length === 0);
  attachmentList.replaceChildren();
  for (const state of states) {
    const row = document.createElement('div');
    row.className = `attachment-queue-item ${state.status}`;
    row.setAttribute('role', 'listitem');
    const icon = document.createElement('span');
    icon.className = 'attachment-preview-icon';
    icon.textContent = '📎';
    const info = document.createElement('div');
    info.className = 'attachment-preview-info';
    const name = document.createElement('strong');
    name.textContent = state.name;
    const meta = document.createElement('span');
    if (state.status === 'queued') meta.textContent = '대기 중';
    if (state.status === 'uploading') meta.textContent = `업로드 중 · ${Math.round(state.progress || 0)}%`;
    if (state.status === 'ready') meta.textContent = `${formatBytes(state.meta.size)} · 준비됨`;
    if (state.status === 'error') meta.textContent = state.error || '업로드 실패';
    info.append(name, meta);
    if (state.status === 'uploading') {
      const track = document.createElement('div');
      track.className = 'upload-progress-track';
      const bar = document.createElement('div');
      bar.className = 'upload-progress-bar';
      bar.style.width = `${state.progress || 0}%`;
      track.appendChild(bar);
      info.appendChild(track);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${state.name} 첨부 제거`);
    remove.addEventListener('click', () => clearPendingAttachment(activeConvId, state.clientId));
    row.append(icon, info, remove);
    attachmentList.appendChild(row);
  }
  const busy = states.some(state => ['queued', 'uploading'].includes(state.status));
  sendBtn.disabled = !isConnected() || busy;
}

function isConnected() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function sendMessage() {
  const content = msgInput.value.trim();
  if (content === '!도움') {
    msgInput.value = '';
    closeMentionMenu();
    delete drafts[activeConvId];
    persistDrafts();
    resizeComposer();
    updateCharCount();
    openHelpModal();
    return;
  }
  const states = getPendingAttachments(activeConvId);
  if (states.some(state => ['queued', 'uploading'].includes(state.status))) {
    showToast('모든 파일 업로드가 끝날 때까지 기다려 주세요.', 'warning');
    return;
  }
  if (states.some(state => state.status === 'error')) {
    showToast('실패한 첨부 파일을 제거해 주세요.', 'error');
    return;
  }
  const readyAttachments = states.filter(state => state.status === 'ready' && state.meta);
  if (!content && readyAttachments.length === 0) return;
  if (content.length > MAX_MSG_LEN) {
    showToast(`메시지는 ${MAX_MSG_LEN}자 이하여야 합니다.`, 'error');
    return;
  }
  if (!isConnected()) {
    addSystemMessage(activeConvId, '⚠️ 서버에 연결되지 않았습니다.');
    return;
  }

  const conv = conversations.get(activeConvId);
  const payload = {
    type: conv && conv.type === 'dm' ? 'dm' : 'chat',
    content,
  };
  if (conv && conv.type === 'dm') {
    payload.to = conv.name;
  } else if (conv && conv.type === 'channel') {
    payload.channel_id = conv.channelId;
  }
  if (readyAttachments.length) payload.attachment_ids = readyAttachments.map(state => state.meta.id);
  const reply = replyTargets.get(activeConvId);
  if (reply) payload.reply = reply;
  ws.send(JSON.stringify(payload));

  msgInput.value = '';
  closeMentionMenu();
  delete drafts[activeConvId];
  persistDrafts();
  replyTargets.delete(activeConvId);
  pendingAttachments.delete(activeConvId);
  resizeComposer();
  updateCharCount();
  renderComposerPreviews();
  msgInput.focus();
}

function replaceComposerText(start, end, replacement, selectionStart, selectionEnd) {
  msgInput.setRangeText(replacement, start, end, 'end');
  msgInput.setSelectionRange(selectionStart, selectionEnd);
  msgInput.dispatchEvent(new Event('input', { bubbles: true }));
  msgInput.focus();
}

function wrapComposerSelection(open, close, placeholder) {
  const start = msgInput.selectionStart;
  const end = msgInput.selectionEnd;
  const selected = msgInput.value.slice(start, end) || placeholder;
  const replacement = open + selected + close;
  replaceComposerText(
    start, end, replacement,
    start + open.length,
    start + open.length + selected.length,
  );
}

function toggleComposerLinePrefix(prefix, placeholder) {
  const value = msgInput.value;
  const selectionStart = msgInput.selectionStart;
  const selectionEnd = msgInput.selectionEnd;
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const nextBreak = value.indexOf('\n', selectionEnd);
  const end = nextBreak === -1 ? value.length : nextBreak;
  const source = value.slice(start, end);
  if (!source) {
    replaceComposerText(start, end, prefix + placeholder,
      start + prefix.length, start + prefix.length + placeholder.length);
    return;
  }
  const lines = source.split('\n');
  const prefixed = lines.filter(line => line.trim()).every(line => line.startsWith(prefix));
  const replacement = lines.map(line => {
    if (!line.trim()) return line;
    return prefixed ? line.slice(prefix.length) : prefix + line;
  }).join('\n');
  replaceComposerText(start, end, replacement, start, start + replacement.length);
}

function applyMarkdownFormat(action) {
  if (action === 'bold') wrapComposerSelection('**', '**', '굵은 텍스트');
  if (action === 'italic') wrapComposerSelection('*', '*', '기울임 텍스트');
  if (action === 'strike') wrapComposerSelection('~~', '~~', '취소선 텍스트');
  if (action === 'code') wrapComposerSelection('`', '`', '코드');
  if (action === 'quote') toggleComposerLinePrefix('> ', '인용문');
  if (action === 'bullet') toggleComposerLinePrefix('• ', '목록 항목');
  if (action === 'codeblock') wrapComposerSelection('```\n', '\n```', '코드');
  if (action === 'link') {
    const start = msgInput.selectionStart;
    const end = msgInput.selectionEnd;
    const label = msgInput.value.slice(start, end) || '링크 텍스트';
    const url = 'https://example.com';
    const replacement = `[${label}](${url})`;
    const urlStart = start + label.length + 3;
    replaceComposerText(start, end, replacement, urlStart, urlStart + url.length);
  }
}

markdownToolbar.addEventListener('mousedown', event => {
  if (event.target.closest('button')) event.preventDefault();
});
markdownToolbar.addEventListener('click', event => {
  const button = event.target.closest('[data-markdown]');
  if (button) applyMarkdownFormat(button.dataset.markdown);
});

msgInput.addEventListener('input', () => {
  drafts[activeConvId] = msgInput.value;
  if (!msgInput.value) delete drafts[activeConvId];
  persistDrafts();
  resizeComposer();
  updateCharCount();
  updateMentionMenu();
});
msgInput.addEventListener('keydown', event => {
  if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLocaleLowerCase();
    const action = key === 'b' ? 'bold'
      : key === 'i' ? 'italic'
      : key === 'k' ? 'link'
      : key === 'x' && event.shiftKey ? 'strike'
      : null;
    if (action) {
      event.preventDefault();
      applyMarkdownFormat(action);
      return;
    }
  }
  if (!event.isComposing && !mentionMenu.classList.contains('hidden')) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMentionActiveIndex(mentionActiveIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMentionMenu();
      return;
    }
  }
  if (event.key === ' ' && !event.isComposing && msgInput.selectionStart === msgInput.selectionEnd) {
    const caret = msgInput.selectionStart;
    const lineStart = msgInput.value.lastIndexOf('\n', caret - 1) + 1;
    const prefix = msgInput.value.slice(lineStart, caret);
    const bulletStart = prefix.match(/^(\s*)-$/);
    if (bulletStart) {
      event.preventDefault();
      const inserted = `${bulletStart[1]}• `;
      msgInput.setRangeText(inserted, lineStart, caret, 'end');
      msgInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }
  if (event.key === 'Enter' && event.shiftKey && !event.isComposing
      && msgInput.selectionStart === msgInput.selectionEnd) {
    const caret = msgInput.selectionStart;
    const lineStart = msgInput.value.lastIndexOf('\n', caret - 1) + 1;
    const currentLine = msgInput.value.slice(lineStart, caret);
    const bulletLine = currentLine.match(/^(\s*)•\s(.*)$/);
    if (bulletLine) {
      event.preventDefault();
      if (bulletLine[2].trim()) {
        msgInput.setRangeText(`\n${bulletLine[1]}• `, caret, caret, 'end');
      } else {
        msgInput.setRangeText('', lineStart, caret, 'end');
      }
      msgInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
msgInput.addEventListener('click', updateMentionMenu);
document.addEventListener('mousedown', event => {
  if (event.target !== msgInput && !mentionMenu.contains(event.target)) closeMentionMenu();
});
sendBtn.addEventListener('click', sendMessage);
replyCancel.addEventListener('click', () => {
  replyTargets.delete(activeConvId);
  renderComposerPreviews();
  msgInput.focus();
});

function chooseFiles(fileList) {
  const incoming = [...(fileList || [])];
  if (!incoming.length) return;
  const states = getPendingAttachments(activeConvId);
  if (states.length >= MAX_FILES) {
    showToast(`파일은 메시지당 최대 ${MAX_FILES}개까지 첨부할 수 있습니다.`, 'warning');
    return;
  }
  let skippedForLimit = 0;
  for (const file of incoming) {
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      showToast(`${file.name}: ${MAX_FILE_MB}MB를 초과했습니다.`, 'error');
      continue;
    }
    if (states.length >= MAX_FILES) {
      skippedForLimit += 1;
      continue;
    }
    states.push({
      clientId: ++attachmentSequence,
      status: 'queued',
      name: file.name,
      file,
      progress: 0,
      xhr: null,
      meta: null,
    });
  }
  if (skippedForLimit) {
    showToast(`${skippedForLimit}개 파일은 제외했습니다. 메시지당 최대 ${MAX_FILES}개입니다.`, 'warning');
  }
  if (states.length) pendingAttachments.set(activeConvId, states);
  renderComposerPreviews();
  processUploadQueue();
}

function activeUploadCount() {
  let count = 0;
  for (const states of pendingAttachments.values()) {
    count += states.filter(state => state.status === 'uploading').length;
  }
  return count;
}

function processUploadQueue() {
  let available = MAX_PARALLEL_UPLOADS - activeUploadCount();
  if (available <= 0) return;
  for (const [convId, states] of pendingAttachments) {
    for (const state of states) {
      if (available <= 0) return;
      if (state.status !== 'queued') continue;
      startAttachmentUpload(convId, state);
      available -= 1;
    }
  }
}

function startAttachmentUpload(convId, state) {
  state.status = 'uploading';
  const xhr = new XMLHttpRequest();
  state.xhr = xhr;
  xhr.open('POST', '/api/files');
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(state.file.name));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) return;
    state.progress = Math.round((event.loaded / event.total) * 100);
    if (activeConvId === convId) renderComposerPreviews();
  });
  xhr.addEventListener('load', () => {
    let response = {};
    try { response = JSON.parse(xhr.responseText || '{}'); } catch { /* invalid error payload */ }
    if (xhr.status === 201) {
      state.status = 'ready';
      state.progress = 100;
      state.meta = response;
      state.file = null;
      refreshStorageWarning();
    } else {
      state.status = 'error';
      state.error = response.detail || `업로드 실패 (${xhr.status})`;
      showToast(`${state.name}: ${state.error}`, 'error');
    }
    if (activeConvId === convId) renderComposerPreviews();
    processUploadQueue();
  });
  xhr.addEventListener('error', () => {
    state.status = 'error';
    state.error = navigator.onLine === false
      ? '이 PC의 네트워크 연결이 끊어졌습니다.'
      : '서버 연결이 끊겼거나 선택한 파일을 읽을 수 없습니다. 접속 주소와 로그인 상태를 확인해 주세요.';
    if (activeConvId === convId) renderComposerPreviews();
    processUploadQueue();
  });
  xhr.addEventListener('abort', () => {
    if (activeConvId === convId) renderComposerPreviews();
    processUploadQueue();
  });
  try {
    xhr.send(state.file);
  } catch {
    state.status = 'error';
    state.error = '선택한 파일을 읽을 수 없거나 업로드 요청을 시작하지 못했습니다. 파일이 이동·삭제되지 않았는지 확인해 주세요.';
    showToast(`${state.name}: ${state.error}`, 'error');
    if (activeConvId === convId) renderComposerPreviews();
    processUploadQueue();
  }
  if (activeConvId === convId) renderComposerPreviews();
}

async function clearPendingAttachment(convId, clientId, discardRemote = true) {
  const states = getPendingAttachments(convId);
  const index = states.findIndex(state => state.clientId === clientId);
  if (index < 0) return;
  const [state] = states.splice(index, 1);
  if (!states.length) pendingAttachments.delete(convId);
  if (state.status === 'uploading' && state.xhr) state.xhr.abort();
  if (discardRemote && state.status === 'ready' && state.meta?.id) {
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(state.meta.id)}`, {
        method: 'DELETE',
      });
    } catch { /* the user can retry removing the pending file */ }
  }
  if (activeConvId === convId) renderComposerPreviews();
  processUploadQueue();
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  chooseFiles(fileInput.files);
  fileInput.value = '';
});

chatArea.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.remove('hidden');
});
chatArea.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
chatArea.addEventListener('dragleave', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.add('hidden');
});
chatArea.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  chooseFiles(event.dataTransfer?.files);
});
msgInput.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) {
    event.preventDefault();
    chooseFiles(files);
  }
});

async function copyText(text, successMessage) {
  if (!text) return;
  let copied = false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch {
      copied = false;
    }
  }

  if (copied) {
    showToast(successMessage, 'success');
  } else {
    showToast('클립보드에 복사하지 못했습니다.', 'error');
  }
}

function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  toastRegion.replaceChildren(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 3200);
}

function setConnected(connected) {
  connStatus.textContent = connected ? '연결됨' : '연결 끊김';
  connStatus.className = `conn-status ${connected ? 'connected' : 'disconnected'}`;
  msgInput.disabled = !connected;
  attachBtn.disabled = !connected;
  renderComposerPreviews();
}

function getWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

function initWebSocket() {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    setConnected(true);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data.type) {
      case 'channels': {
        const chans = Array.isArray(data.channels) ? data.channels : [];
        chans.forEach(chan => {
          channelsDirectory.set(chan.id, chan);
          getOrCreateChannel(chan);
        });
        renderConversationList();
        break;
      }
      case 'channel_created': {
        if (data.channel) {
          channelsDirectory.set(data.channel.id, data.channel);
          getOrCreateChannel(data.channel);
          renderConversationList();
          showToast(`'# ${data.channel.display_name}' 채널이 생성되었습니다.`, 'info');
        }
        break;
      }
      case 'channel_updated': {
        if (data.channel) {
          updateChannelData(data.channel);
          showToast(`'# ${data.channel.display_name}' 채널 정보가 수정되었습니다.`, 'info');
        }
        break;
      }
      case 'channel_archived': {
        const chanId = Number(data.channel_id);
        const chan = channelsDirectory.get(chanId);
        const displayName = chan?.display_name || `채널 ${chanId}`;
        removeChannelData(chanId);
        showToast(`'# ${displayName}' 채널이 보관되었습니다.`, 'info');
        break;
      }
      case 'channel_unarchived': {
        if (data.channel) {
          channelsDirectory.set(data.channel.id, data.channel);
          getOrCreateChannel(data.channel);
          renderConversationList();
          showToast(`'# ${data.channel.display_name}' 채널 보관이 해제되었습니다.`, 'info');
        }
        break;
      }
      case 'channel_deleted': {
        const chanId = Number(data.channel_id);
        const chan = channelsDirectory.get(chanId);
        const displayName = chan?.display_name || `채널 ${chanId}`;
        removeChannelData(chanId);
        showToast(`'# ${displayName}' 채널이 영구 삭제되었습니다.`, 'info');
        break;
      }
      case 'message_edited': {
        if (data.message) {
          const editedMsg = data.message;
          const chanId = Number(editedMsg.channel_id || 1);
          const targetConvId = 'channel:' + chanId;
          const conv = conversations.get(targetConvId);
          if (conv) {
            const idx = conv.messages.findIndex(m => m.message_id === editedMsg.message_id);
            if (idx >= 0) {
              conv.messages[idx].content = editedMsg.content;
              conv.messages[idx].edited_at = editedMsg.edited_at;
              conv.messages[idx].mentions = editedMsg.mentions;
              if (activeConvId === targetConvId) {
                renderMessages();
              }
            }
          }
        }
        break;
      }
      case 'message_hidden': {
        if (data.message) {
          const hiddenMsg = data.message;
          const chanId = Number(hiddenMsg.channel_id || 1);
          const targetConvId = 'channel:' + chanId;
          const conv = conversations.get(targetConvId);
          if (conv) {
            const idx = conv.messages.findIndex(m => m.message_id === hiddenMsg.message_id);
            if (idx >= 0) {
              conv.messages[idx].is_hidden = Boolean(data.is_hidden ?? hiddenMsg.is_hidden);
              if (activeConvId === targetConvId) {
                renderMessages();
              }
            }
          }
        }
        break;
      }
      case 'message_moved': {
        const fromChanId = Number(data.from_channel_id || 1);
        const toChanId = Number(data.to_channel_id || 1);
        const movedMsg = data.message;
        const fromConvId = 'channel:' + fromChanId;
        const toConvId = 'channel:' + toChanId;
        
        const fromConv = conversations.get(fromConvId);
        if (fromConv) {
          fromConv.messages = fromConv.messages.filter(m => m.message_id !== movedMsg.message_id);
          fromConv.messageIds.delete(movedMsg.message_id);
        }
        
        const toConv = conversations.get(toConvId);
        if (toConv && !toConv.messageIds.has(movedMsg.message_id)) {
          toConv.messageIds.add(movedMsg.message_id);
          toConv.messages.push(publicMessageFromData(movedMsg));
        }

        if (activeConvId === fromConvId) {
          const row = messageListEl.querySelector(`.msg-row[data-message-id="${movedMsg.message_id}"]`);
          if (row) row.remove();
        } else if (activeConvId === toConvId) {
          const wasAtBottom = (messageListEl.scrollHeight - messageListEl.scrollTop - messageListEl.clientHeight) < 50;
          renderMessages({ preserveScroll: !wasAtBottom });
        }
        break;
      }
      case 'read_state_updated': {
        if (data.state) {
          const key = `${data.state.conversation_type}:${data.state.conversation_id}`;
          userConversationStates.set(key, data.state);
          const targetConv = findDmConv(key) || conversations.get(key);
          if (targetConv) {
            userConversationStates.set(targetConv.id, data.state);
          }
        }
        if (data.unread_counts && typeof data.unread_counts === 'object') {
          Object.entries(data.unread_counts).forEach(([k, v]) => {
            userUnreadCounts.set(k, v);
            const conv = findDmConv(k) || conversations.get(k);
            if (conv) {
              if (conv.id === activeConvId) {
                conv.unread = 0;
                userUnreadCounts.set(k, 0);
                userUnreadCounts.set(conv.id, 0);
              } else {
                conv.unread = v;
                userUnreadCounts.set(conv.id, v);
              }
            }
          });
          renderConversationList();
        }
        break;
      }
      case 'conversation_muted_updated': {
        if (data.state) {
          const key = `${data.state.conversation_type}:${data.state.conversation_id}`;
          const curr = userConversationStates.get(key) || {};
          const merged = { ...curr, ...data.state };
          userConversationStates.set(key, merged);
          const targetConv = findDmConv(key) || conversations.get(key);
          if (targetConv) {
            userConversationStates.set(targetConv.id, merged);
          }
          updateMuteButtonUI();
          renderConversationList();
        }
        break;
      }
      case 'chat': {
        const chanId = Number(data.channel_id || 1);
        const targetConvId = 'channel:' + chanId;
        if (!conversations.has(targetConvId)) {
          if (channelsDirectory.has(chanId)) {
            getOrCreateChannel(channelsDirectory.get(chanId));
          } else {
            getOrCreateChannel({ id: chanId, name: `channel-${chanId}`, display_name: `채널 ${chanId}` });
          }
          renderConversationList();
        }
        const chatMessage = publicMessageFromData(data);
        const added = addMessage(targetConvId, chatMessage, { markUnread: !data.history });
        if (targetConvId === activeConvId) {
          ackActiveConversationRead();
        } else {
          const currCnt = userUnreadCounts.get(targetConvId) || 0;
          userUnreadCounts.set(targetConvId, currCnt + 1);
          renderConversationList();
        }
        const isOwn = data.nickname === myNickname || (myUserId !== null && Number(data.author_id) === myUserId);
        if (!data.history && added && !isOwn) {
          const senderDisplay = displayNickname(data.nickname);
          const chanObj = channelsDirectory.get(chanId);
          const chanTitle = chanObj?.display_name || (chanId === 1 ? '전체 채팅' : `채널 ${chanId}`);
          const contentPreview = (data.content || '파일 전송').slice(0, 50);

          const mentionsMe = Array.isArray(chatMessage.mentioned_user_ids)
            && chatMessage.mentioned_user_ids.some(id => Number(id) === myUserId);
          const repliesToMe = Boolean(chatMessage.reply && chatMessage.reply.nickname === myNickname);

          if (repliesToMe) {
            emitAttention({
              kind: 'reply',
              conversationId: targetConvId,
              title: `#${chanTitle} · ${senderDisplay}`,
              body: `${senderDisplay}님이 회원님의 메시지에 답장했습니다: ${contentPreview}`,
              isHistory: Boolean(data.history),
              isOwnMessage: isOwn,
              senderNick: data.nickname,
            });
          } else if (mentionsMe) {
            emitAttention({
              kind: 'mention',
              conversationId: targetConvId,
              title: `#${chanTitle} · ${senderDisplay}`,
              body: `${senderDisplay}님이 회원님을 멘션했습니다: ${contentPreview}`,
              isHistory: Boolean(data.history),
              isOwnMessage: isOwn,
              senderNick: data.nickname,
            });
          } else {
            emitAttention({
              kind: 'ordinary',
              conversationId: targetConvId,
              title: `#${chanTitle}`,
              body: `${senderDisplay}: ${contentPreview}`,
              isHistory: Boolean(data.history),
              isOwnMessage: isOwn,
              senderNick: data.nickname,
            });
          }
        }
        break;
      }
      case 'dm': {
        const partner = data.from_nick === myNickname ? data.to_nick : data.from_nick;
        const partnerUserId = data.from_nick === myNickname ? data.to_user_id : data.from_user_id;
        const conv = getOrCreateDm(partner, partnerUserId);
        const targetConvId = conv.id;
        renderConversationList();
        const added = addMessage(targetConvId, directMessageFromData(data), { markUnread: !data.history });
        if (targetConvId === activeConvId) {
          conv.unread = 0;
          userUnreadCounts.set(targetConvId, 0);
          if (partnerUserId) userUnreadCounts.set(`dm:${partnerUserId}`, 0);
          ackActiveConversationRead();
        } else if (added && !data.history) {
          const currCnt = getConvUnreadCount(conv);
          userUnreadCounts.set(targetConvId, currCnt);
          if (partnerUserId) userUnreadCounts.set(`dm:${partnerUserId}`, currCnt);
          renderConversationList();
        }
        const isOwn = data.from_nick === myNickname || (myUserId !== null && Number(data.from_user_id) === myUserId);
        const senderDisplay = displayNickname(data.from_nick);
        const contentPreview = (data.content || '파일 전송').slice(0, 50);

        if (!data.history && added && !isOwn) {
          emitAttention({
            kind: 'dm',
            conversationId: targetConvId,
            title: `💬 1:1 대화 · ${senderDisplay}`,
            body: contentPreview,
            isHistory: Boolean(data.history),
            isOwnMessage: isOwn,
            senderNick: data.from_nick,
          });
        }
        break;
      }
      case 'history_ready': {
        const global = conversations.get(GLOBAL_ID);
        if (global) global.hasOlder = Boolean(data.public_has_older);
        const dmHasOlder = data.dm_has_older && typeof data.dm_has_older === 'object'
          ? data.dm_has_older : {};
        Object.entries(dmHasOlder).forEach(([partner, hasOlder]) => {
          getOrCreateDm(partner).hasOlder = Boolean(hasOlder);
        });
        if (data.read_states && typeof data.read_states === 'object') {
          Object.entries(data.read_states).forEach(([k, v]) => {
            userConversationStates.set(k, v);
            const targetConv = findDmConv(k) || conversations.get(k);
            if (targetConv) {
              userConversationStates.set(targetConv.id, v);
            }
          });
        }
        if (data.unread_counts && typeof data.unread_counts === 'object') {
          Object.entries(data.unread_counts).forEach(([k, v]) => {
            userUnreadCounts.set(k, v);
            const conv = findDmConv(k) || conversations.get(k);
            if (conv) {
              if (conv.id === activeConvId) {
                conv.unread = 0;
                userUnreadCounts.set(k, 0);
                userUnreadCounts.set(conv.id, 0);
              } else {
                conv.unread = v;
                userUnreadCounts.set(conv.id, v);
              }
            }
          });
        }
        ackActiveConversationRead();
        updateMuteButtonUI();
        renderConversationList();
        updateLoadOlderButton();
        break;
      }
      case 'attachment_deleted':
        applyAttachmentDeleted(data.attachment_id);
        break;
      case 'presence':
        break;
      case 'users':
        mentionUsers = Array.isArray(data.mention_list) ? data.mention_list : [];
        userDirectory.clear();
        mentionUsers.forEach(user => {
          userDirectory.set(user.username, {
            id: user.id,
            username: user.username,
            display_name: user.display_name || user.username,
            online: Boolean(user.online),
          });
        });
        conversations.forEach(conv => {
          if (conv.type === 'dm') {
            const u = userDirectory.get(conv.name);
            if (u) conv.partnerUserId = u.id;
          }
        });
        if (myNickname) {
          const me = userDirectory.get(myNickname);
          if (me && me.display_name !== myDisplayName) {
            myDisplayName = me.display_name;
            if (currentUser) currentUser.display_name = myDisplayName;
            updateNickBadge();
          }
        }
        renderOnlineList(mentionUsers);
        renderConversationList();
        updateMentionMenu();
        break;
      case 'error':
        addSystemMessage(activeConvId, `⚠️ ${data.message}`);
        showToast(data.message || '요청을 처리하지 못했습니다.', 'error');
        break;
    }
  };

  ws.onclose = event => {
    setConnected(false);
    mentionUsers = [];
    renderOnlineList([]);
    if (event.code === 1008) {
      currentUser = null;
      myUserId = null;
      myNickname = '';
      showAuthModal('세션이 만료되었습니다. 다시 로그인해 주세요.');
    } else if (currentUser) {
      scheduleReconnect();
    }
  };
  ws.onerror = () => setConnected(false);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  addSystemMessage(activeConvId, '연결이 끊어졌습니다. 재연결을 시도합니다...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (myNickname) initWebSocket();
  }, RECONNECT_DELAY);
}

window.addEventListener('beforeunload', saveCurrentDraft);
resizeComposer();
updateCharCount();
setConnected(false);
applyCollapsedSections();
bootstrapAuth();
