// ============================================================
// Auth Module: Authentication, Nickname, Admin Management & Help Modals
// ============================================================

import { state, setCurrentUser } from './state.js';
import { formatTime, formatBytes, showToast } from './utils.js';
import { refreshQuizHeaderStreak } from './quiz.js';

const SAVED_USERNAME_KEY = 'bamboochat_saved_username';
let authMode = 'login';
let nicknameHintTimer = null;
let quizHintTimer = null;
let lastStorageWarning = 0;

export async function refreshStorageWarning() {
  if (!state.currentUser) return;
  try {
    const response = await fetch('/api/storage', { cache: 'no-store' });
    if (!response.ok) return;
    const status = await response.json();
    const level = Number(status.warning_level || 0);
    if (level && level !== lastStorageWarning) {
      showToast(`저장 공간이 ${level}% 이상 사용 중입니다. 불필요한 파일을 삭제해 주세요.`, level >= 95 ? 'error' : 'warning');
    }
    lastStorageWarning = level;
  } catch { /* advisory only */ }
}

export function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  const registerFields = document.getElementById('register-fields');
  const authRememberRow = document.getElementById('auth-remember-row');
  const authSubmit = document.getElementById('auth-submit');
  const passwordInput = document.getElementById('password-input');
  const authModeToggle = document.getElementById('auth-mode-toggle');
  const authError = document.getElementById('auth-error');

  if (registerFields) registerFields.classList.toggle('hidden', !registering);
  if (authRememberRow) authRememberRow.classList.toggle('hidden', registering);
  if (authSubmit) authSubmit.textContent = registering ? '계정 만들기' : '로그인';
  if (passwordInput) passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  if (authModeToggle) {
    authModeToggle.textContent = registering ? '이미 계정이 있나요? 로그인' : '처음인가요? 계정 만들기';
  }
  if (authError) authError.textContent = '';
}

export function showAuthModal(message = '') {
  const authError = document.getElementById('auth-error');
  const authModal = document.getElementById('auth-modal');
  const chatApp = document.getElementById('chat-app');
  const usernameInput = document.getElementById('username-input');
  const passwordInput = document.getElementById('password-input');
  const rememberIdInput = document.getElementById('remember-id-input');

  if (authError) authError.textContent = message;
  if (authModal) authModal.classList.remove('hidden');
  if (chatApp) chatApp.classList.add('hidden');

  const savedUsername = localStorage.getItem(SAVED_USERNAME_KEY);
  if (savedUsername && usernameInput) {
    usernameInput.value = savedUsername;
    if (rememberIdInput) rememberIdInput.checked = true;
    setTimeout(() => passwordInput?.focus(), 50);
  } else if (usernameInput) {
    if (rememberIdInput) rememberIdInput.checked = false;
    setTimeout(() => usernameInput?.focus(), 50);
  }
}

export function hideAuthModal() {
  const authModal = document.getElementById('auth-modal');
  if (authModal) authModal.classList.add('hidden');
}

export function showNicknameHint() {
  const nicknameHintPopover = document.getElementById('nickname-hint-popover');
  if (!nicknameHintPopover || !state.currentUser) return;
  if (nicknameHintTimer) clearTimeout(nicknameHintTimer);
  nicknameHintPopover.classList.remove('hidden');
  nicknameHintTimer = setTimeout(() => {
    hideNicknameHint(true);
  }, 6000);
}

export function hideNicknameHint(triggerNext = false) {
  if (nicknameHintTimer) {
    clearTimeout(nicknameHintTimer);
    nicknameHintTimer = null;
  }
  const nicknameHintPopover = document.getElementById('nickname-hint-popover');
  if (nicknameHintPopover) {
    nicknameHintPopover.classList.add('hidden');
  }
  if (triggerNext && state.currentUser) {
    showQuizHint();
  }
}

export function showQuizHint() {
  const quizHintPopover = document.getElementById('quiz-hint-popover');
  if (!quizHintPopover || !state.currentUser) return;
  if (quizHintTimer) clearTimeout(quizHintTimer);
  quizHintPopover.classList.remove('hidden');
  quizHintTimer = setTimeout(() => {
    hideQuizHint();
  }, 6000);
}

export function hideQuizHint() {
  if (quizHintTimer) {
    clearTimeout(quizHintTimer);
    quizHintTimer = null;
  }
  const quizHintPopover = document.getElementById('quiz-hint-popover');
  if (quizHintPopover) {
    quizHintPopover.classList.add('hidden');
  }
}

export function updateNickBadge() {
  const myNickBadge = document.getElementById('my-nick-badge');
  if (!myNickBadge || !state.currentUser) return;
  const name = state.currentUser.display_name || state.currentUser.username;
  const suffix = state.currentUser.role === 'admin' ? ' · 관리자' : '';
  myNickBadge.textContent = name + suffix;
  myNickBadge.title = `${name} (@${state.currentUser.username}) — 닉네임 변경`;
}

async function loadNicknameTitles() {
  const select = document.getElementById('nickname-title-select');
  const help = document.getElementById('nickname-title-help');
  if (!select) return;
  select.disabled = true;
  try {
    const response = await fetch('/api/auth/quiz-titles', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '칭호를 불러오지 못했습니다.');
    select.replaceChildren(new Option('누적 점수 표시', 'score'), new Option('표시 안 함', 'none'));
    (data.titles || []).forEach(title => {
      const detail = title.rank ? `${title.category} ${title.rank}위` : title.title;
      select.add(new Option(`${title.icon} ${title.label} · ${detail}`, title.selection));
    });
    select.value = data.selected || 'score';
    if (!select.value) select.value = 'score';
    if (help) help.textContent = data.titles?.length
      ? '획득한 순위 또는 연속 학습 칭호 중 하나를 선택할 수 있습니다.'
      : '과목별 점수 3위 또는 3일 연속 학습을 달성하면 칭호가 열립니다.';
  } catch (error) {
    if (help) help.textContent = error.message;
  } finally {
    select.disabled = false;
  }
}

export function openNicknameModal() {
  hideNicknameHint();
  const nicknameCurrentName = document.getElementById('nickname-current-name');
  const nicknameUsernameLabel = document.getElementById('nickname-username-label');
  const nicknameInput = document.getElementById('nickname-input');
  const nicknameError = document.getElementById('nickname-error');
  const nicknameModal = document.getElementById('nickname-modal');

  if (nicknameCurrentName) nicknameCurrentName.textContent = state.currentUser?.display_name || state.currentUser?.username;
  if (nicknameUsernameLabel) nicknameUsernameLabel.textContent = `@${state.currentUser?.username}`;
  if (nicknameInput) nicknameInput.value = state.currentUser?.display_name || state.currentUser?.username || '';
  if (nicknameError) nicknameError.textContent = '';
  if (nicknameModal) nicknameModal.classList.remove('hidden');
  loadNicknameTitles();
  setTimeout(() => nicknameInput?.focus(), 50);
}

export function closeNicknameModal() {
  const nicknameModal = document.getElementById('nickname-modal');
  const nicknameError = document.getElementById('nickname-error');
  const msgInput = document.getElementById('msg-input');
  if (nicknameModal) nicknameModal.classList.add('hidden');
  if (nicknameError) nicknameError.textContent = '';
  if (state.currentUser && msgInput) msgInput.focus();
}

export async function submitNickname(event) {
  event.preventDefault();
  const nicknameInput = document.getElementById('nickname-input');
  const nicknameError = document.getElementById('nickname-error');
  const nicknameSubmit = document.getElementById('nickname-submit');
  const titleSelect = document.getElementById('nickname-title-select');

  const name = nicknameInput?.value.trim();
  if (!name) {
    if (nicknameError) nicknameError.textContent = '닉네임을 입력해 주세요.';
    return;
  }
  if (nicknameSubmit) nicknameSubmit.disabled = true;
  if (nicknameError) nicknameError.textContent = '';
  try {
    const response = await fetch('/api/auth/display-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '닉네임을 변경하지 못했습니다.');
    const titleResponse = await fetch('/api/auth/quiz-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: titleSelect?.value || 'score' }),
    });
    const titleData = await titleResponse.json().catch(() => ({}));
    if (!titleResponse.ok) throw new Error(titleData.detail || '칭호를 변경하지 못했습니다.');
    if (state.currentUser) state.currentUser.display_name = data.display_name || name;
    if (state.currentUser) {
      state.currentUser.quiz_badge = titleData.quiz_badge || null;
      state.currentUser.quiz_badge_selection = titleData.selected || 'score';
    }
    updateNickBadge();
    closeNicknameModal();
    showToast('닉네임과 칭호를 저장했습니다.', 'success');
  } catch (error) {
    if (nicknameError) nicknameError.textContent = error.message || '닉네임을 변경하지 못했습니다.';
  } finally {
    if (nicknameSubmit) nicknameSubmit.disabled = false;
  }
}

export function openHelpModal() {
  const helpModal = document.getElementById('help-modal');
  const helpClose = document.getElementById('help-close');
  if (helpModal) helpModal.classList.remove('hidden');
  helpClose?.focus();
}

export function closeHelpModal() {
  const helpModal = document.getElementById('help-modal');
  const msgInput = document.getElementById('msg-input');
  if (helpModal) helpModal.classList.add('hidden');
  if (state.currentUser && msgInput) msgInput.focus();
}

export async function adminJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `관리 요청 실패 (${response.status})`);
  return data;
}

export function storageLine(label, used, limit) {
  const percent = limit ? Math.round((used / limit) * 1000) / 10 : 0;
  return `${label}: ${formatBytes(used)} / ${formatBytes(limit)} (${percent}%)`;
}

export function filterAdminUserRows() {
  const adminUsers = document.getElementById('admin-users');
  const adminUserSearch = document.getElementById('admin-user-search');
  const adminUserSearchEmpty = document.getElementById('admin-user-search-empty');
  if (!adminUsers) return;
  const query = (adminUserSearch ? adminUserSearch.value : '').trim().toLowerCase();
  const rows = adminUsers.querySelectorAll('.admin-user');
  let visibleCount = 0;
  rows.forEach(row => {
    const text = row.dataset.searchText || '';
    const match = !query || text.includes(query);
    row.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  if (adminUserSearchEmpty) {
    adminUserSearchEmpty.classList.toggle('hidden', rows.length === 0 || visibleCount > 0);
  }
}

export function renderAdminUsers(users) {
  const adminUsers = document.getElementById('admin-users');
  const adminError = document.getElementById('admin-error');
  if (!adminUsers) return;
  adminUsers.replaceChildren();
  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;

  users.forEach(user => {
    const savedActive = Boolean(user.active);
    const row = document.createElement('div');
    row.className = `admin-user${savedActive ? '' : ' inactive'}`;
    const displayName = user.display_name || user.username;
    row.dataset.username = user.username || '';
    row.dataset.displayName = displayName;
    row.dataset.searchText = `${user.username} ${displayName}`.toLowerCase();

    const identity = document.createElement('div');
    identity.className = 'admin-user-identity';
    const name = document.createElement('strong');
    name.textContent = displayName !== user.username ? `${displayName} (@${user.username})` : user.username;

    const details = document.createElement('small');
    details.textContent = `메시지 ${user.message_count}개 · 파일 ${formatBytes(user.attachment_bytes)}`;

    const lastLogin = document.createElement('small');
    const lastLoginTime = user.last_login ? formatTime(user.last_login) : '기록 없음';
    const lastLoginIp = user.last_login_ip || '기록 없음';
    lastLogin.textContent = `최근 로그인: ${lastLoginTime} (${lastLoginIp})`;

    const ip = document.createElement('small');
    ip.textContent = `현재 접속 IP: ${user.current_ip || '오프라인'}`;

    identity.append(name, details, lastLogin, ip);

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
      if (adminError) adminError.textContent = '';
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
        if (adminError) adminError.textContent = error.message;
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
  filterAdminUserRows();
}

export async function loadAdminOverview() {
  const adminRegistrationEnabled = document.getElementById('admin-registration-enabled');
  const adminStorage = document.getElementById('admin-storage');
  const adminError = document.getElementById('admin-error');
  if (adminError) adminError.textContent = '';
  try {
    const overview = await adminJson('/api/admin/overview', { cache: 'no-store' });
    if (adminRegistrationEnabled) adminRegistrationEnabled.checked = Boolean(overview.registration_enabled);
    const storage = overview.storage;
    if (adminStorage) {
      adminStorage.replaceChildren();
      [
        storageLine('첨부 파일', storage.attachment_bytes, storage.attachment_limit_bytes),
        storageLine('데이터베이스', storage.database_bytes, storage.database_limit_bytes),
      ].forEach(text => {
        const line = document.createElement('div');
        line.textContent = text;
        adminStorage.appendChild(line);
      });
    }
    renderAdminUsers(overview.users || []);
    await loadArchivedChannels();
  } catch (error) {
    if (adminError) adminError.textContent = error.message;
  }
}

async function loadArchivedChannels() {
  const container = document.getElementById('admin-archived-channels');
  if (!container) return;
  const response = await fetch('/api/channels?include_archived=true', { cache: 'no-store' });
  const data = await response.json().catch(() => ([]));
  if (!response.ok) throw new Error(data.detail || '보관된 채널을 불러오지 못했습니다.');
  const archived = Array.isArray(data) ? data.filter(channel => channel.archived) : [];
  container.replaceChildren();
  if (!archived.length) {
    container.textContent = '보관된 채널이 없습니다.';
    return;
  }
  archived.forEach(channel => {
    const row = document.createElement('div');
    row.className = 'admin-user';
    const identity = document.createElement('div');
    identity.className = 'admin-user-identity';
    const name = document.createElement('strong');
    name.textContent = `# ${channel.display_name}`;
    const detail = document.createElement('small');
    detail.textContent = `${channel.name} · 메시지 ${channel.message_count || 0}개`;
    identity.append(name, detail);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '보관 해제';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        const res = await fetch(`/api/channels/${channel.id}/unarchive`, { method: 'POST' });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.detail || '채널 보관을 해제하지 못했습니다.');
        row.remove();
        if (!container.children.length) container.textContent = '보관된 채널이 없습니다.';
        showToast(`#${channel.display_name} 채널의 보관을 해제했습니다.`, 'success');
      } catch (error) {
        showToast(error.message || '채널 보관을 해제하지 못했습니다.', 'error');
        restore.disabled = false;
      }
    });
    row.append(identity, restore);
    container.appendChild(row);
  });
}

export async function openAdminPanel() {
  const adminModal = document.getElementById('admin-modal');
  const adminUserSearch = document.getElementById('admin-user-search');
  if (adminModal) adminModal.classList.remove('hidden');
  await loadAdminOverview();
  if (adminUserSearch) adminUserSearch.focus();
}

export function closeAdminPanel() {
  const adminModal = document.getElementById('admin-modal');
  const adminEnrollmentCode = document.getElementById('admin-enrollment-code');
  const adminUserSearch = document.getElementById('admin-user-search');
  const adminError = document.getElementById('admin-error');
  if (adminModal) adminModal.classList.add('hidden');
  if (adminEnrollmentCode) adminEnrollmentCode.value = '';
  if (adminUserSearch) adminUserSearch.value = '';
  if (adminError) adminError.textContent = '';
}

export function initAuthListeners(onLoginSuccess, onLogout) {
  const authForm = document.getElementById('auth-form');
  const authModeToggle = document.getElementById('auth-mode-toggle');
  const logoutBtn = document.getElementById('logout-btn');
  const helpBtn = document.getElementById('help-btn');
  const helpClose = document.getElementById('help-close');
  const helpModal = document.getElementById('help-modal');
  const adminBtn = document.getElementById('admin-btn');
  const adminClose = document.getElementById('admin-close');
  const adminModal = document.getElementById('admin-modal');
  const myNickBadge = document.getElementById('my-nick-badge');
  const nicknameHintClose = document.getElementById('nickname-hint-close');
  const nicknameHintPopover = document.getElementById('nickname-hint-popover');
  const quizHintClose = document.getElementById('quiz-hint-close');
  const quizHintPopover = document.getElementById('quiz-hint-popover');
  const quizBtn = document.getElementById('quiz-btn');
  const nicknameClose = document.getElementById('nickname-close');
  const nicknameModal = document.getElementById('nickname-modal');
  const nicknameForm = document.getElementById('nickname-form');
  const adminUserSearch = document.getElementById('admin-user-search');
  const adminRegistrationSave = document.getElementById('admin-registration-save');
  const adminEnrollmentSave = document.getElementById('admin-enrollment-save');

  if (authForm) {
    authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const usernameInput = document.getElementById('username-input');
      const passwordInput = document.getElementById('password-input');
      const passwordConfirmInput = document.getElementById('password-confirm-input');
      const enrollmentInput = document.getElementById('enrollment-input');
      const rememberIdInput = document.getElementById('remember-id-input');
      const authSubmit = document.getElementById('auth-submit');
      const authError = document.getElementById('auth-error');

      const username = usernameInput?.value.trim();
      const password = passwordInput?.value;
      if (!username || !password) {
        if (authError) authError.textContent = '아이디와 비밀번호를 입력해 주세요.';
        return;
      }
      const body = { username, password };
      if (authMode === 'register') {
        if (password !== passwordConfirmInput?.value) {
          if (authError) authError.textContent = '비밀번호가 일치하지 않습니다.';
          return;
        }
        body.enrollment_code = enrollmentInput?.value;
      }
      if (authSubmit) authSubmit.disabled = true;
      if (authError) authError.textContent = '';
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
        if (passwordInput) passwordInput.value = '';
        if (passwordConfirmInput) passwordConfirmInput.value = '';
        if (enrollmentInput) enrollmentInput.value = '';
        setCurrentUser(data);
        hideAuthModal();
        if (onLoginSuccess) await onLoginSuccess(data);
      } catch (error) {
        if (authError) authError.textContent = error.message || '로그인하지 못했습니다.';
      } finally {
        if (authSubmit) authSubmit.disabled = false;
      }
    });
  }

  if (authModeToggle) {
    authModeToggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      hideNicknameHint(false);
      hideQuizHint();
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
      setCurrentUser(null);
      if (onLogout) onLogout();
      showAuthModal();
    });
  }

  if (helpBtn) helpBtn.addEventListener('click', openHelpModal);
  if (helpClose) helpClose.addEventListener('click', closeHelpModal);
  if (helpModal) {
    helpModal.addEventListener('click', event => {
      if (event.target === helpModal) closeHelpModal();
    });
  }

  if (adminBtn) adminBtn.addEventListener('click', openAdminPanel);
  if (adminClose) adminClose.addEventListener('click', closeAdminPanel);
  if (adminModal) {
    adminModal.addEventListener('click', event => {
      if (event.target === adminModal) closeAdminPanel();
    });
  }

  if (myNickBadge) myNickBadge.addEventListener('click', openNicknameModal);
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

  // Quiz hint popover
  if (quizHintClose) {
    quizHintClose.addEventListener('click', event => {
      event.stopPropagation();
      hideQuizHint();
    });
  }
  if (quizHintPopover) {
    quizHintPopover.addEventListener('click', event => {
      if (event.target === quizHintClose || quizHintClose?.contains(event.target)) return;
      hideQuizHint();
      // Open quiz modal — click the quiz button programmatically
      quizBtn?.click();
    });
  }
  // Also hide quiz hint when the quiz button itself is clicked
  if (quizBtn) {
    quizBtn.addEventListener('click', () => hideQuizHint(), { capture: true });
  }
  if (nicknameClose) nicknameClose.addEventListener('click', closeNicknameModal);
  if (nicknameModal) {
    nicknameModal.addEventListener('click', event => {
      if (event.target === nicknameModal) closeNicknameModal();
    });
  }
  if (nicknameForm) nicknameForm.addEventListener('submit', submitNickname);

  if (adminUserSearch) {
    adminUserSearch.addEventListener('input', filterAdminUserRows);
  }

  if (adminRegistrationSave) {
    adminRegistrationSave.addEventListener('click', async () => {
      const adminRegistrationEnabled = document.getElementById('admin-registration-enabled');
      const adminError = document.getElementById('admin-error');
      adminRegistrationSave.disabled = true;
      if (adminError) adminError.textContent = '';
      try {
        await adminJson('/api/admin/registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: adminRegistrationEnabled?.checked }),
        });
        showToast('신규 가입 설정을 변경했습니다.', 'success');
      } catch (error) {
        if (adminError) adminError.textContent = error.message;
      } finally {
        adminRegistrationSave.disabled = false;
      }
    });
  }

  if (adminEnrollmentSave) {
    adminEnrollmentSave.addEventListener('click', async () => {
      const adminEnrollmentCode = document.getElementById('admin-enrollment-code');
      const adminError = document.getElementById('admin-error');
      adminEnrollmentSave.disabled = true;
      if (adminError) adminError.textContent = '';
      try {
        await adminJson('/api/admin/enrollment-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enrollment_code: adminEnrollmentCode?.value }),
        });
        if (adminEnrollmentCode) adminEnrollmentCode.value = '';
        showToast('교실 가입 코드를 변경했습니다.', 'success');
      } catch (error) {
        if (adminError) adminError.textContent = error.message;
      } finally {
        adminEnrollmentSave.disabled = false;
      }
    });
  }
}

export async function bootstrapAuth(onAuthSuccess) {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) throw new Error('not signed in');
    const user = await response.json();
    setCurrentUser(user);
    hideAuthModal();
    if (onAuthSuccess) await onAuthSuccess(user);
  } catch {

    showAuthModal();
  }
}
