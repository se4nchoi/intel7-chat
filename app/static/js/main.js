// ============================================================
// Classroom Chat — Master Javascript Entrypoint
// Native ES Module Architecture
// ============================================================

import { state, setCurrentUser, setActiveRoom } from './state.js';
import { showToast } from './utils.js';
import { initAuthListeners, bootstrapAuth, updateNickBadge, showNicknameHint } from './auth.js';
import { loadChannels, renderChannels, initChannelsListeners, channelsDirectory } from './channels.js';
import { renderDms, displayNickname, getOrCreateDm } from './dm.js';
import {
  loadDrafts,
  saveCurrentDraft,
  loadActiveDraft,
  resizeComposer,
  updateCharCount,
  renderComposerPreviews,
  renderMessages,
  initChatListeners,
  replyTargets,
  pendingAttachments,
} from './chat.js';
import { initWebSocket, sendWebSocketMessage } from './ws.js';
import { fetchActivePinnedMessages, initPinsListeners } from './pins.js';
import { initQuizListeners, refreshQuizHeaderStreak, refreshQuizSidebarCounts } from './quiz.js';
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
} from './notifications.js';
import { playNotificationSound, setSoundMode, setSoundVolume } from './audio.js';


// --- Room Switching ---
async function switchConversation(type, id) {
  saveCurrentDraft();
  setActiveRoom(type, id);

  const chatAreaTitle = document.getElementById('chat-area-title');
  const chatAreaDesc = document.getElementById('chat-area-desc');
  const msgInput = document.getElementById('msg-input');
  const channelSettingsBtn = document.getElementById('channel-settings-btn');
  const loadOlderBtn = document.getElementById('load-older-btn');

  if (type === 'channel') {
    const chanId = Number(id);
    const chanObj = channelsDirectory.get(chanId);
    const displayName = chanObj?.display_name || (chanId === 1 ? '전체 채팅' : `채널 ${chanId}`);
    if (chatAreaTitle) chatAreaTitle.textContent = `# ${displayName}`;
    if (chatAreaDesc) chatAreaDesc.textContent = chanObj?.description || '';
    if (msgInput) msgInput.placeholder = `# ${displayName}에 메시지 입력`;
    if (channelSettingsBtn) {
      channelSettingsBtn.classList.toggle('hidden', state.currentUser?.role !== 'admin');
    }
  } else {
    const displayName = displayNickname(String(id));
    if (chatAreaTitle) chatAreaTitle.textContent = `💬 ${displayName}`;
    if (chatAreaDesc) chatAreaDesc.textContent = '';
    if (msgInput) msgInput.placeholder = `${displayName}에게 DM 보내기`;
    if (channelSettingsBtn) channelSettingsBtn.classList.add('hidden');
  }

  loadActiveDraft();
  renderComposerPreviews();
  updateConversationNotificationUI();
  renderChannels(switchConversation);
  renderDms(switchConversation);

  // Fetch conversation messages
  try {
    const endpoint = type === 'channel'
      ? `/api/history/public`
      : `/api/history/dm/${encodeURIComponent(id)}`;
    const res = await fetch(endpoint, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      renderMessages(messages);
      if (loadOlderBtn) {
        loadOlderBtn.classList.toggle('hidden', !data.has_more);
      }
    }
  } catch { /* ignore */ }


  fetchActivePinnedMessages({ autoOpen: false });

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
    delete drafts[currentKey];
    replyTargets.delete(currentKey);
    pendingAttachments.delete(currentKey);
    resizeComposer();
    updateCharCount();
    renderComposerPreviews();
    msgInput.focus();
  }
}

// --- App Bootstrap ---
function initApp() {
  const sidebarToggle = document.getElementById('sidebar-toggle');

  const sidebar = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const headerNotifBtn = document.getElementById('header-notif-btn');
  const convMuteBtn = document.getElementById('conv-mute-btn');
  const globalNotificationModalClose = document.getElementById('global-notification-modal-close');
  const globalNotificationModalCancel = document.getElementById('global-notification-modal-cancel');
  const convNotificationModalClose = document.getElementById('conv-notification-modal-close');
  const convNotificationModalCancel = document.getElementById('conv-notification-modal-cancel');
  const convNotificationToggleBtn = document.getElementById('conv-notif-toggle-btn');
  const soundModeInputs = document.querySelectorAll('input[name="sound-mode"]');
  const soundVolumeSlider = document.getElementById('sound-volume-slider');
  const soundTestBtn = document.getElementById('sound-test-btn');
  const desktopNotifToggleBtn = document.getElementById('desktop-notif-toggle-btn');
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
  initPinsListeners();
  initQuizListeners();
  initSidebarSections();


  const onLoginSuccess = async (user) => {
    const chatApp = document.getElementById('chat-app');
    const adminBtn = document.getElementById('admin-btn');
    const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
    if (chatApp) chatApp.classList.remove('hidden');
    if (adminBtn) adminBtn.classList.toggle('hidden', user?.role !== 'admin');
    if (quizNavAdminBtn) quizNavAdminBtn.classList.toggle('hidden', user?.role !== 'admin');
    updateNickBadge();
    loadDrafts();
    await loadChannels(switchConversation);
    await switchConversation('channel', 1);
    initWebSocket({
      onSwitchConv: (convKey) => {
        const [type, id] = convKey.split(':');
        switchConversation(type, id);
      },
      onOpenDm: (nick) => switchConversation('dm', nick),
      onDmsUpdated: () => renderDms(switchConversation),
      onUnreadUpdated: () => {
        renderChannels(switchConversation);
        renderDms(switchConversation);
      },
      onMuteUpdated: () => {
        updateConversationNotificationUI();
        renderChannels(switchConversation);
        renderDms(switchConversation);
      },
    });
    showNicknameHint();
    refreshQuizHeaderStreak();
    refreshQuizSidebarCounts();
  };



  const onLogout = () => {
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

