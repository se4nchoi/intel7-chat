// ============================================================
// BambooChat: Discord-Style Multi-Channel & DM Screen Sharing Engine
// WebRTC Mesh + Pan/Zoom + PiP + Insecure Origin Helper
// ============================================================

import { state } from './state.js';
import { showToast, copyText } from './utils.js';
import { sendWebSocketMessage } from './ws.js';
import { channelsDirectory, renderChannels } from './channels.js';
import { displayNickname } from './dm.js';

// --- Room ID Helpers ---
export function normalizeRoomKey(id) {
  if (id === null || id === undefined) return '';
  const str = String(id).trim();
  if (str.startsWith('dm:')) return str.toLowerCase();
  const num = Number(str);
  return isNaN(num) ? str : String(num);
}

export function getDmRoomId(userA, userB) {
  if (!userA || !userB) return null;
  const sorted = [String(userA).toLowerCase(), String(userB).toLowerCase()].sort();
  return `dm:${sorted[0]}:${sorted[1]}`;
}

export function getCurrentRoomId() {
  if (!state.activeRoom) return null;
  if (state.activeRoom.type === 'channel') {
    return normalizeRoomKey(state.activeRoom.id);
  } else if (state.activeRoom.type === 'dm') {
    return getDmRoomId(state.currentUser?.username, state.activeRoom.id);
  }
  return null;
}

// --- State ---
export const screenshareState = {
  // Map of normalized roomId (string: e.g. "1", "2", "dm:alice:bob") -> Session object
  activeSessions: new Map(),
  // Presenter tracking (roomId)
  presentingChannelId: null,
  localStream: null,
  // Viewer tracking (roomId)
  viewingChannelId: null,
  // Peer connections: targetUserId -> RTCPeerConnection
  peerConnections: new Map(),
  // Pan & Zoom state
  zoom: 1.0,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  // Panel collapsed state
  isCollapsed: false,

  hasSession(roomId) {
    return this.activeSessions.has(normalizeRoomKey(roomId));
  },

  getSession(roomId) {
    return this.activeSessions.get(normalizeRoomKey(roomId));
  }
};

// --- DOM Element References ---
let panelContainer = null;
let panelHeader = null;
let liveTag = null;
let presenterNameEl = null;
let streamTitleEl = null;
let viewerPillEl = null;
let toggleViewBtn = null;
let stopBtn = null;
let canvasContainer = null;
let videoEl = null;
let zoomLabel = null;
let stickyBar = null;
let stickyChanName = null;
let stickyGotoBtn = null;
let stickyStopBtn = null;
let helpModal = null;
let headerToggleBtn = null;

// --- Initialization ---
export function initScreenShareUI() {
  panelContainer = document.getElementById('screenshare-panel-container');
  panelHeader = document.getElementById('screenshare-panel-header');
  liveTag = document.getElementById('ss-live-tag');
  presenterNameEl = document.getElementById('ss-presenter-name');
  streamTitleEl = document.getElementById('ss-stream-title');
  viewerPillEl = document.getElementById('ss-viewer-pill');
  toggleViewBtn = document.getElementById('ss-btn-toggle-view');
  stopBtn = document.getElementById('ss-btn-stop');
  canvasContainer = document.getElementById('ss-canvas-container');
  videoEl = document.getElementById('screenshare-video');
  zoomLabel = document.getElementById('ss-zoom-label');
  stickyBar = document.getElementById('screenshare-sticky-bar');
  stickyChanName = document.getElementById('ss-sticky-chan-name');
  stickyGotoBtn = document.getElementById('ss-sticky-goto-btn');
  stickyStopBtn = document.getElementById('ss-sticky-stop-btn');
  helpModal = document.getElementById('screenshare-help-modal');
  headerToggleBtn = document.getElementById('screenshare-toggle-btn');

  // Header button: click to start or focus screenshare in current room
  if (headerToggleBtn) {
    headerToggleBtn.addEventListener('click', handleHeaderToggleClick);
  }

  // Panel actions
  if (toggleViewBtn) {
    toggleViewBtn.addEventListener('click', () => {
      screenshareState.isCollapsed = !screenshareState.isCollapsed;
      panelContainer?.classList.toggle('collapsed', screenshareState.isCollapsed);
      toggleViewBtn.textContent = screenshareState.isCollapsed ? '펼치기' : '접기';
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      const activeRoomId = getCurrentRoomId();
      if (activeRoomId) stopScreenShare(activeRoomId);
    });
  }

  // Sticky bar actions
  if (stickyGotoBtn) {
    stickyGotoBtn.addEventListener('click', () => {
      if (!screenshareState.presentingChannelId) return;
      const rid = String(screenshareState.presentingChannelId);
      if (rid.startsWith('dm:')) {
        const parts = rid.split(':');
        const myName = (state.currentUser?.username || '').toLowerCase();
        const partner = parts[1].toLowerCase() === myName ? parts[2] : parts[1];
        window.bambooChatSwitchConversation?.('dm', partner);
      } else {
        window.bambooChatSwitchConversation?.('channel', Number(rid));
      }
    });
  }

  if (stickyStopBtn) {
    stickyStopBtn.addEventListener('click', () => {
      if (screenshareState.presentingChannelId) {
        stopScreenShare(screenshareState.presentingChannelId);
      }
    });
  }

  // Zoom / Pan toolbar
  initPanZoomControls();

  // Insecure help modal
  initHelpModal();
}

// --- Header Button Click Handler ---
async function handleHeaderToggleClick() {
  const roomId = getCurrentRoomId();
  if (!roomId) return;
  const normId = normalizeRoomKey(roomId);

  // If already presenting in this room -> stop
  if (normalizeRoomKey(screenshareState.presentingChannelId) === normId) {
    stopScreenShare(normId);
    return;
  }

  // If already a live stream in this room -> toggle viewing or join
  if (screenshareState.hasSession(normId)) {
    if (normalizeRoomKey(screenshareState.viewingChannelId) === normId) {
      screenshareState.isCollapsed = !screenshareState.isCollapsed;
      panelContainer?.classList.toggle('collapsed', screenshareState.isCollapsed);
      if (toggleViewBtn) toggleViewBtn.textContent = screenshareState.isCollapsed ? '펼치기' : '접기';
    } else {
      joinScreenShare(normId);
    }
    return;
  }

  // Otherwise, start screen sharing in this room (channel or DM)!
  await startScreenShare(normId);
}

// --- Presenter Workflow ---
export async function startScreenShare(roomId, customTitle = '') {
  if (!roomId) roomId = getCurrentRoomId();
  if (!roomId) return;
  const normId = normalizeRoomKey(roomId);

  // Check if browser supports getDisplayMedia
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    openInsecureHelpModal();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30, max: 60 }
      },
      audio: false,
    });

    screenshareState.localStream = stream;
    screenshareState.presentingChannelId = normId;

    // Handle user stopping stream via browser native bar ("Stop sharing")
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        stopScreenShare(normId);
      };
    }

    // Connect local preview
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // Send WebSocket start event
    const isDm = String(normId).startsWith('dm:');
    let targetName = '';
    if (isDm) {
      const parts = String(normId).split(':');
      const myName = (state.currentUser?.username || '').toLowerCase();
      const partner = parts[1].toLowerCase() === myName ? parts[2] : parts[1];
      targetName = `${displayNickname(partner)}님과의 DM`;
    } else {
      const chanObj = channelsDirectory.get(Number(normId));
      targetName = chanObj?.display_name || `채널 #${normId}`;
    }

    const title = customTitle || `${state.currentUser?.display_name || state.currentUser?.username}님의 화면`;
    sendWebSocketMessage({
      type: 'screenshare_start',
      channel_id: isDm ? normId : Number(normId),
      title: title,
    });

    updateUIForCurrentRoom();
    showToast(`'${targetName}'에서 화면 공유를 시작했습니다.`, 'info');
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error('getDisplayMedia error:', err);
      showToast('화면 공유를 시작할 수 없습니다: ' + (err.message || err.name), 'error');
    }
  }
}

export function stopScreenShare(roomId) {
  const normId = normalizeRoomKey(roomId);
  // If presenting
  if (normalizeRoomKey(screenshareState.presentingChannelId) === normId) {
    const isDm = String(normId).startsWith('dm:');
    sendWebSocketMessage({
      type: 'screenshare_stop',
      channel_id: isDm ? normId : Number(normId),
    });

    if (screenshareState.localStream) {
      screenshareState.localStream.getTracks().forEach(t => t.stop());
      screenshareState.localStream = null;
    }
    screenshareState.presentingChannelId = null;

    closeAllPeerConnections();
    showToast('화면 공유가 종료되었습니다.', 'info');
  }

  // If viewing
  if (normalizeRoomKey(screenshareState.viewingChannelId) === normId) {
    leaveScreenShare(normId);
  }

  updateUIForCurrentRoom();
}

// --- Viewer Workflow ---
export function joinScreenShare(roomId) {
  const normId = normalizeRoomKey(roomId);
  if (normalizeRoomKey(screenshareState.presentingChannelId) === normId) return;

  screenshareState.viewingChannelId = normId;
  screenshareState.isCollapsed = false;

  const isDm = String(normId).startsWith('dm:');
  sendWebSocketMessage({
    type: 'screenshare_join',
    channel_id: isDm ? normId : Number(normId),
  });

  updateUIForCurrentRoom();
}

export function leaveScreenShare(roomId) {
  const normId = normalizeRoomKey(roomId);
  if (normalizeRoomKey(screenshareState.viewingChannelId) === normId) {
    const isDm = String(normId).startsWith('dm:');
    sendWebSocketMessage({
      type: 'screenshare_leave',
      channel_id: isDm ? normId : Number(normId),
    });
    screenshareState.viewingChannelId = null;
    closeAllPeerConnections();
    if (videoEl) {
      videoEl.srcObject = null;
    }
  }

  updateUIForCurrentRoom();
}


// --- PeerConnection Cleanup ---
function closeAllPeerConnections() {
  screenshareState.peerConnections.forEach(pc => {
    try { pc.close(); } catch {}
  });
  screenshareState.peerConnections.clear();
}

// --- WebRTC Signaling Handlers ---
export async function handleViewerJoined({ channel_id, viewer_user_id, viewer_username, viewer_display_name }) {
  const normId = normalizeRoomKey(channel_id);
  // Only the active presenter handles new viewers
  if (normalizeRoomKey(screenshareState.presentingChannelId) !== normId || !screenshareState.localStream) return;

  const targetId = Number(viewer_user_id);
  // Create RTCPeerConnection for viewer
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  screenshareState.peerConnections.set(targetId, pc);

  // Add local display tracks
  screenshareState.localStream.getTracks().forEach(track => {
    pc.addTrack(track, screenshareState.localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWebSocketMessage({
        type: 'screenshare_signal',
        channel_id: channel_id,
        target_user_id: targetId,
        signal: { type: 'candidate', candidate: event.candidate },
      });
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWebSocketMessage({
      type: 'screenshare_signal',
      channel_id: channel_id,
      target_user_id: targetId,
      signal: { type: 'offer', sdp: offer.sdp },
    });
  } catch (err) {
    console.error('Failed to create offer for viewer:', err);
  }
}

export function handleViewerLeft({ channel_id, viewer_user_id }) {
  const normId = normalizeRoomKey(channel_id);
  if (normalizeRoomKey(screenshareState.presentingChannelId) !== normId) return;

  const targetId = Number(viewer_user_id);
  const pc = screenshareState.peerConnections.get(targetId);
  if (pc) {
    try { pc.close(); } catch {}
    screenshareState.peerConnections.delete(targetId);
  }
}

export async function handleSignal({ channel_id, from_user_id, signal }) {
  const senderId = Number(from_user_id);
  if (!signal) return;

  // Viewer receives Offer from Presenter
  if (signal.type === 'offer') {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    screenshareState.peerConnections.set(senderId, pc);

    pc.ontrack = (event) => {
      if (videoEl && event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.muted = false;
        videoEl.play().catch(() => {});
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWebSocketMessage({
          type: 'screenshare_signal',
          channel_id: channel_id,
          target_user_id: senderId,
          signal: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWebSocketMessage({
        type: 'screenshare_signal',
        channel_id: channel_id,
        target_user_id: senderId,
        signal: { type: 'answer', sdp: answer.sdp },
      });
    } catch (err) {
      console.error('Failed to process offer / send answer:', err);
    }
    return;
  }

  // Presenter receives Answer from Viewer
  if (signal.type === 'answer') {
    const pc = screenshareState.peerConnections.get(senderId);
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
      } catch (err) {
        console.error('Failed to set remote answer:', err);
      }
    }
    return;
  }

  // ICE Candidate
  if (signal.type === 'candidate' && signal.candidate) {
    const pc = screenshareState.peerConnections.get(senderId);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (err) {
        console.warn('Could not add ICE candidate:', err);
      }
    }
  }
}

// --- WebSocket Event Handlers (Broadcasts) ---
export function onScreenshareStarted(data) {
  const roomId = normalizeRoomKey(data.channel_id);
  screenshareState.activeSessions.set(roomId, {
    channel_id: roomId,
    room_type: data.room_type || (String(roomId).startsWith('dm:') ? 'dm' : 'channel'),
    user_id: data.user_id,
    username: data.username,
    display_name: data.display_name,
    title: data.title,
    viewer_count: data.viewer_count || 1,
  });

  // Re-render sidebar channels & DMs to illuminate LIVE badge
  renderChannels(window.bambooChatSwitchChannel);
  window.bambooChatRenderDms?.();

  // If we are currently in that room, update UI
  const currentRoomId = getCurrentRoomId();
  if (currentRoomId === roomId) {
    updateUIForCurrentRoom();
    // Auto-join as viewer if not presenter
    if (normalizeRoomKey(screenshareState.presentingChannelId) !== roomId) {
      joinScreenShare(roomId);
    }
  }
}

export function onScreenshareStopped(data) {
  const roomId = normalizeRoomKey(data.channel_id);
  screenshareState.activeSessions.delete(roomId);

  // Re-render sidebar channels & DMs to remove LIVE badge
  renderChannels(window.bambooChatSwitchChannel);
  window.bambooChatRenderDms?.();

  // If we were presenting or viewing this room, clean up
  if (normalizeRoomKey(screenshareState.presentingChannelId) === roomId) {
    if (screenshareState.localStream) {
      screenshareState.localStream.getTracks().forEach(t => t.stop());
      screenshareState.localStream = null;
    }
    screenshareState.presentingChannelId = null;
  }

  if (normalizeRoomKey(screenshareState.viewingChannelId) === roomId) {
    screenshareState.viewingChannelId = null;
    if (videoEl) videoEl.srcObject = null;
    closeAllPeerConnections();
  }

  updateUIForCurrentRoom();
}

export function onScreenshareViewersUpdate(data) {
  const roomId = normalizeRoomKey(data.channel_id);
  const session = screenshareState.activeSessions.get(roomId);
  if (session) {
    session.viewer_count = data.viewer_count;
    if (getCurrentRoomId() === roomId && viewerPillEl) {
      viewerPillEl.textContent = `👥 ${data.viewer_count}명`;
    }
  }
}

export function syncAllActiveSessions(sessionsMap) {
  screenshareState.activeSessions.clear();
  if (sessionsMap && typeof sessionsMap === 'object') {
    Object.entries(sessionsMap).forEach(([ridStr, s]) => {
      const rid = normalizeRoomKey(s.channel_id || ridStr);
      screenshareState.activeSessions.set(rid, {
        channel_id: rid,
        room_type: s.room_type || (String(rid).startsWith('dm:') ? 'dm' : 'channel'),
        user_id: s.user_id,
        username: s.username,
        display_name: s.display_name,
        title: s.title,
        viewer_count: s.viewer_count || 1,
      });
    });
  }
  renderChannels(window.bambooChatSwitchChannel);
  window.bambooChatRenderDms?.();
  updateUIForCurrentRoom();
}

// --- Conversation Switching Integration ---
export function handleConversationSwitch(type, id) {
  // If user is currently presenting in another room:
  // Stream stays active, sticky bar will remind them!
  updateStickyBar();

  const currentRoomId = getCurrentRoomId();

  // If user was viewing a different room's stream:
  if (screenshareState.viewingChannelId && normalizeRoomKey(screenshareState.viewingChannelId) !== currentRoomId) {
    leaveScreenShare(screenshareState.viewingChannelId);
  }

  // Update current room UI
  updateUIForCurrentRoom();

  // If the new room has a live stream and user is not presenter, auto-connect!
  if (currentRoomId && screenshareState.hasSession(currentRoomId) && normalizeRoomKey(screenshareState.presentingChannelId) !== currentRoomId) {
    joinScreenShare(currentRoomId);
  }
}

// Backwards compatibility alias
export const handleChannelSwitch = (cid) => handleConversationSwitch('channel', cid);

// --- UI Synchronizer ---
export function updateUIForCurrentRoom() {
  const currentRoomId = getCurrentRoomId();
  const session = currentRoomId ? screenshareState.getSession(currentRoomId) : null;
  const isPresentingHere = Boolean(currentRoomId && normalizeRoomKey(screenshareState.presentingChannelId) === currentRoomId);
  const isViewingHere = Boolean(currentRoomId && normalizeRoomKey(screenshareState.viewingChannelId) === currentRoomId);
  const isLive = Boolean(session);

  // 1. Update Header Button
  if (headerToggleBtn) {
    headerToggleBtn.classList.remove('is-live', 'is-presenting');
    const labelEl = document.getElementById('screenshare-btn-label');
    const isDm = state.activeRoom?.type === 'dm';
    const partnerName = isDm ? displayNickname(state.activeRoom.id) : '';

    if (isPresentingHere) {
      headerToggleBtn.classList.add('is-presenting');
      if (labelEl) labelEl.textContent = '방송 중 (중지)';
      headerToggleBtn.title = '화면 공유 중지하기';
    } else if (isLive) {
      headerToggleBtn.classList.add('is-live');
      if (labelEl) labelEl.textContent = '🔴 방송 시청 중';
      headerToggleBtn.title = isDm ? `${partnerName}님의 화면 시청 중` : '방송 시청 중 (클릭 시 접기/펼치기)';
    } else {
      if (labelEl) labelEl.textContent = '화면 공유';
      headerToggleBtn.title = isDm ? `${partnerName}님과 화면 공유하기` : '이 채널에 화면 공유하기';
    }
  }

  // 2. Update Panel Container
  if (!panelContainer) return;

  if (!isLive && !isPresentingHere) {
    panelContainer.classList.add('hidden');
    resetPanZoom();
    updateStickyBar();
    return;
  }

  // Show panel
  panelContainer.classList.remove('hidden');
  panelContainer.classList.toggle('collapsed', screenshareState.isCollapsed);

  // Update Panel Header details
  const displayTitle = session?.title || `${state.currentUser?.display_name || state.currentUser?.username}님의 화면`;
  const presenterNick = isPresentingHere ? '나' : (session?.display_name || session?.username || '발표자');
  const count = session?.viewer_count || 1;

  if (presenterNameEl) presenterNameEl.textContent = presenterNick;
  if (streamTitleEl) streamTitleEl.textContent = displayTitle;
  if (viewerPillEl) viewerPillEl.textContent = `👥 ${count}명`;

  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !isPresentingHere);
  }
  if (toggleViewBtn) {
    toggleViewBtn.textContent = screenshareState.isCollapsed ? '펼치기' : '접기';
  }

  updateStickyBar();
}

// Backwards compatibility alias
export const updateUIForChannel = () => updateUIForCurrentRoom();

function updateStickyBar() {
  if (!stickyBar) return;
  const presentingId = screenshareState.presentingChannelId;
  if (!presentingId) {
    stickyBar.classList.add('hidden');
    return;
  }

  const currentRoomId = getCurrentRoomId();
  const isDifferentRoom = normalizeRoomKey(presentingId) !== currentRoomId;

  // Show sticky bar only if presenter navigated AWAY from the streaming room
  if (isDifferentRoom) {
    let targetName = '';
    const isDm = String(presentingId).startsWith('dm:');
    if (isDm) {
      const parts = String(presentingId).split(':');
      const myName = (state.currentUser?.username || '').toLowerCase();
      const partner = parts[1].toLowerCase() === myName ? parts[2] : parts[1];
      targetName = `${displayNickname(partner)}님과의 DM`;
    } else {
      const chanObj = channelsDirectory.get(Number(presentingId));
      targetName = chanObj?.display_name || `채널 #${presentingId}`;
    }
    if (stickyChanName) stickyChanName.textContent = targetName;
    stickyBar.classList.remove('hidden');
  } else {
    stickyBar.classList.add('hidden');
  }
}


// --- Interactive Pan & Zoom Engine (Single-Monitor Friendly) ---
function initPanZoomControls() {
  const zoomInBtn = document.getElementById('ss-btn-zoom-in');
  const zoomOutBtn = document.getElementById('ss-btn-zoom-out');
  const zoomResetBtn = document.getElementById('ss-btn-zoom-reset');
  const pipBtn = document.getElementById('ss-btn-pip');
  const fsBtn = document.getElementById('ss-btn-fs');
  const viewport = document.getElementById('ss-viewport');

  // Zoom In / Out / Reset
  zoomInBtn?.addEventListener('click', () => setZoom(screenshareState.zoom + 0.25));
  zoomOutBtn?.addEventListener('click', () => setZoom(screenshareState.zoom - 0.25));
  zoomResetBtn?.addEventListener('click', resetPanZoom);
  zoomLabel?.addEventListener('click', resetPanZoom);

  // PiP (Picture-in-Picture)
  pipBtn?.addEventListener('click', async () => {
    if (!videoEl) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && !videoEl.disablePictureInPicture) {
        await videoEl.requestPictureInPicture();
      } else {
        showToast('이 브라우저에서는 PiP 모드를 지원하지 않습니다.', 'warning');
      }
    } catch (err) {
      console.warn('PiP error:', err);
    }
  });

  // Fullscreen
  fsBtn?.addEventListener('click', () => {
    if (!viewport) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      viewport.requestFullscreen().catch(() => {});
    }
  });

  // Mouse Wheel Zoom (pointer-centered)
  viewport?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomDelta = e.deltaY < 0 ? 0.2 : -0.2;
    const newZoom = Math.min(Math.max(0.5, screenshareState.zoom + zoomDelta), 3.0);

    if (newZoom !== screenshareState.zoom) {
      // Zoom centered on mouse
      const factor = newZoom / screenshareState.zoom;
      screenshareState.panX = mouseX - factor * (mouseX - screenshareState.panX);
      screenshareState.panY = mouseY - factor * (mouseY - screenshareState.panY);
      screenshareState.zoom = Math.round(newZoom * 100) / 100;
      applyTransform();
    }
  }, { passive: false });

  // Double click: toggle 100% / 200%
  viewport?.addEventListener('dblclick', () => {
    if (screenshareState.zoom > 1.05) {
      resetPanZoom();
    } else {
      setZoom(2.0);
    }
  });

  // Drag-to-pan when zoomed in
  viewport?.addEventListener('pointerdown', (e) => {
    if (screenshareState.zoom <= 1.0) return;
    screenshareState.isPanning = true;
    screenshareState.panStartX = e.clientX - screenshareState.panX;
    screenshareState.panStartY = e.clientY - screenshareState.panY;
    canvasContainer?.classList.add('is-panning');
    viewport.setPointerCapture(e.pointerId);
  });

  viewport?.addEventListener('pointermove', (e) => {
    if (!screenshareState.isPanning) return;
    screenshareState.panX = e.clientX - screenshareState.panStartX;
    screenshareState.panY = e.clientY - screenshareState.panStartY;
    applyTransform();
  });

  const endPan = (e) => {
    if (screenshareState.isPanning) {
      screenshareState.isPanning = false;
      canvasContainer?.classList.remove('is-panning');
      try { viewport.releasePointerCapture(e.pointerId); } catch {}
    }
  };

  viewport?.addEventListener('pointerup', endPan);
  viewport?.addEventListener('pointercancel', endPan);
}

function setZoom(val) {
  screenshareState.zoom = Math.min(Math.max(0.5, Math.round(val * 100) / 100), 3.0);
  if (screenshareState.zoom <= 1.0) {
    screenshareState.panX = 0;
    screenshareState.panY = 0;
  }
  applyTransform();
}

function resetPanZoom() {
  screenshareState.zoom = 1.0;
  screenshareState.panX = 0;
  screenshareState.panY = 0;
  applyTransform();
}

function applyTransform() {
  if (!canvasContainer) return;
  canvasContainer.style.transform = `translate(${screenshareState.panX}px, ${screenshareState.panY}px) scale(${screenshareState.zoom})`;
  canvasContainer.classList.toggle('can-pan', screenshareState.zoom > 1.0);
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(screenshareState.zoom * 100)}%`;
  }
}

// --- Insecure Origin Guidance Modal ---
function initHelpModal() {
  const closeBtn = document.getElementById('ss-help-modal-close');
  const confirmBtn = document.getElementById('ss-help-modal-confirm');
  const copyFlagBtn = document.getElementById('ss-copy-flag-btn');
  const copyOriginBtn = document.getElementById('ss-copy-origin-btn');
  const originInput = document.getElementById('ss-help-origin-input');
  const flagInput = document.getElementById('ss-help-flag-input');

  const updateOriginValues = () => {
    const origin = window.location.origin;
    if (originInput) originInput.value = origin;
  };
  updateOriginValues();

  const closeModal = () => helpModal?.classList.add('hidden');
  closeBtn?.addEventListener('click', closeModal);
  confirmBtn?.addEventListener('click', closeModal);

  flagInput?.addEventListener('click', () => flagInput.select());
  originInput?.addEventListener('click', () => originInput.select());

  copyFlagBtn?.addEventListener('click', async () => {
    const text = flagInput?.value || 'chrome://flags/#unsafely-treat-insecure-origin-as-secure';
    const ok = await copyText(text, '플래그 주소가 복사되었습니다.');
    if (ok && copyFlagBtn) {
      const orig = copyFlagBtn.textContent;
      copyFlagBtn.textContent = '✓ 복사됨!';
      setTimeout(() => { copyFlagBtn.textContent = orig; }, 2000);
    }
  });

  copyOriginBtn?.addEventListener('click', async () => {
    const text = originInput?.value || window.location.origin;
    const ok = await copyText(text, '서버 주소가 복사되었습니다.');
    if (ok && copyOriginBtn) {
      const orig = copyOriginBtn.textContent;
      copyOriginBtn.textContent = '✓ 복사됨!';
      setTimeout(() => { copyOriginBtn.textContent = orig; }, 2000);
    }
  });
}

function openInsecureHelpModal() {
  if (helpModal) {
    const originInput = document.getElementById('ss-help-origin-input');
    if (originInput) originInput.value = window.location.origin;
    helpModal.classList.remove('hidden');
  }
}
