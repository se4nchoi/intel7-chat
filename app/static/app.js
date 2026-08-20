/**
 * BambooChat client: authenticated conversations, safe Markdown, replies, drafts and files.
 */
'use strict';

const DRAFTS_PREFIX = 'bamboochat_drafts_';
const SAVED_USERNAME_KEY = 'bamboochat_saved_username';
const RECONNECT_DELAY = 3000;
const GLOBAL_ID = 'global';

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
const retentionNote = document.getElementById('retention-note');
const connStatus = document.getElementById('conn-status');
const myNickBadge = document.getElementById('my-nick-badge');
const nicknameHintPopover = document.getElementById('nickname-hint-popover');
const nicknameHintClose = document.getElementById('nickname-hint-close');
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

function initConversations() {
  conversations.clear();
  conversations.set(GLOBAL_ID, {
    id: GLOBAL_ID, name: '전체 채팅', type: 'global',
    messages: [], messageIds: new Set(), unread: 0, hasOlder: false, loadingOlder: false,
  });
}

function displayNickname(nick) {
  const entry = userDirectory.get(nick);
  return entry?.display_name || nick;
}

function getOrCreateDm(nick) {
  if (!conversations.has(nick)) {
    conversations.set(nick, {
      id: nick, name: nick, type: 'dm', messages: [],
      messageIds: new Set(), unread: 0, hasOlder: false, loadingOlder: false,
    });
  }
  return conversations.get(nick);
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

function showNicknameHint() {
  if (!nicknameHintPopover) return;
  if (nicknameHintTimer) clearTimeout(nicknameHintTimer);
  nicknameHintPopover.classList.remove('hidden');
  nicknameHintTimer = setTimeout(() => {
    hideNicknameHint();
  }, 5000);
}

function hideNicknameHint() {
  if (nicknameHintTimer) {
    clearTimeout(nicknameHintTimer);
    nicknameHintTimer = null;
  }
  if (nicknameHintPopover) {
    nicknameHintPopover.classList.add('hidden');
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
  switchConversation(GLOBAL_ID);
  initWebSocket();
  refreshStorageWarning();
  showNicknameHint();
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
  hideNicknameHint();
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
  messageListEl.replaceChildren();
  setConnected(false);
  setAuthMode('login');
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

sidebarToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarBackdrop.classList.toggle('hidden', !open);
});
sidebarBackdrop.addEventListener('click', closeSidebar);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !nicknameModal.classList.contains('hidden')) closeNicknameModal();
  else if (event.key === 'Escape' && !helpModal.classList.contains('hidden')) closeHelpModal();
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

function switchConversation(id) {
  if (!conversations.has(id)) return;
  saveCurrentDraft();
  activeConvId = id;
  closeMentionMenu();
  const conv = conversations.get(id);
  conv.unread = 0;
  const displayName = displayNickname(conv.name, conv.ipSuffix);
  chatAreaTitle.textContent = conv.type === 'global' ? '🌐 전체 채팅' : `💬 ${displayName}`;
  retentionNote.textContent = '⚠️ HTTP LAN · 암호화되지 않음 · 민감정보 공유 금지';
  retentionNote.classList.toggle('dm-warning', conv.type !== 'global');
  msgInput.placeholder = conv.type === 'global'
    ? '메시지를 입력하세요'
    : `${displayName}에게 DM 보내기`;
  loadActiveDraft();
  renderComposerPreviews();
  renderMessages();
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
  convListEl.replaceChildren();
  for (const conv of conversations.values()) {
    const item = document.createElement('li');
    item.className = `conv-item${conv.id === activeConvId ? ' active' : ''}`;
    item.dataset.id = conv.id;
    const icon = document.createElement('span');
    icon.className = 'conv-icon';
    icon.textContent = conv.type === 'global' ? '🌐' : '👤';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = displayNickname(conv.name, conv.ipSuffix);
    item.append(icon, name);
    if (conv.unread > 0) {
      const badge = document.createElement('span');
      badge.className = `conv-unread${conv.type === 'dm' ? ' dm-unread' : ''}`;
      badge.textContent = conv.unread > 99 ? '99+' : String(conv.unread);
      item.appendChild(badge);
    }
    const activate = () => switchConversation(conv.id);
    item.addEventListener('click', activate);
    makeKeyboardClickable(item, activate);
    convListEl.appendChild(item);
  }
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
        getOrCreateDm(nick);
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
  if (activeConvId !== GLOBAL_ID || msgInput.selectionStart !== msgInput.selectionEnd) return null;
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
  if (msg.message_id) row.dataset.messageId = msg.message_id;

  if (isChat && !grouped) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nick = document.createElement('span');
    nick.className = 'nick';
    nick.textContent = displayNickname(msg.nickname);
    const time = document.createElement('time');
    time.dateTime = msg.created_at || '';
    time.textContent = formatTime(msg.created_at);
    meta.append(nick, time);
    row.appendChild(meta);
  } else if (!isChat && !grouped) {
    const label = document.createElement('div');
    label.className = 'dm-label';
    label.textContent = isOwn
      ? `${displayNickname(msg.to_nick)}`
      : `${displayNickname(msg.from_nick)}`;
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
  if (msg.content) {
    const markdown = document.createElement('div');
    renderMarkdown(markdown, msg.content);
    highlightMentions(markdown, msg.mentions);
    bubble.appendChild(markdown);
  }
  const attachments = normaliseMessageAttachments(msg);
  if (attachments.length) {
    const group = document.createElement('div');
    group.className = 'message-attachments';
    attachments.forEach(attachment => group.appendChild(createAttachmentEntry(attachment)));
    bubble.appendChild(group);
  }
  const actions = createMessageActions(msg);
  bubble.addEventListener('click', event => {
    if (!window.matchMedia('(hover: none), (max-width: 640px)').matches) return;
    if (event.target.closest('a, button')) return;
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

function renderMessages() {
  messageListEl.replaceChildren();
  const conv = conversations.get(activeConvId);
  if (!conv) return;
  conv.messages.forEach((message, index) => {
    appendMessageNode(message, index > 0 ? conv.messages[index - 1] : null);
  });
  scrollBottom();
}

function publicMessageFromData(data) {
  return {
    msgType: 'chat',
    message_id: data.message_id,
    nickname: data.nickname,
    author_id: data.author_id,
    content: data.content || '',
    created_at: data.created_at,
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
    to_nick: data.to_nick,
    content: data.content || '',
    created_at: data.created_at,
    reply: data.reply || null,
    attachment: data.attachment || null,
    attachments: Array.isArray(data.attachments) ? data.attachments : null,
    attachment_removed: Boolean(data.attachment_removed),
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
    const path = conv.type === 'global'
      ? '/api/history/public'
      : `/api/history/dm/${encodeURIComponent(conv.name)}`;
    const response = await fetch(`${path}?before_id=${beforeId}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '이전 메시지를 불러오지 못했습니다.');
    const messages = (Array.isArray(data.messages) ? data.messages : []).map(item =>
      conv.type === 'global' ? publicMessageFromData(item) : directMessageFromData(item)
    );
    prependMessages(conv, messages);
    conv.hasOlder = Boolean(data.has_more);
    if (conv.id === activeConvId) {
      renderMessages();
      messageListEl.scrollTop = 0;
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

  const payload = {
    type: activeConvId === GLOBAL_ID ? 'chat' : 'dm',
    content,
  };
  if (activeConvId !== GLOBAL_ID) payload.to = activeConvId;
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
      case 'chat': {
        const chatMessage = publicMessageFromData(data);
        const added = addMessage(GLOBAL_ID, chatMessage);
        if (!data.history && added && messageNeedsMyAttention(chatMessage)) {
          const senderDisplay = displayNickname(data.nickname);
          const repliesToMe = data.reply && data.reply.nickname === myNickname;
          showToast(
            repliesToMe
              ? `${senderDisplay}님이 회원님의 메시지에 답장했습니다.`
              : `${senderDisplay}님이 전체 채팅에서 회원님을 멘션했습니다.`,
            'mention',
          );
        }
        break;
      }
      case 'dm': {
        const partner = data.from_nick === myNickname ? data.to_nick : data.from_nick;
        getOrCreateDm(partner);
        renderConversationList();
        addMessage(partner, directMessageFromData(data), { markUnread: !data.history });
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
        // Update own display name if changed by another session or admin
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
bootstrapAuth();
