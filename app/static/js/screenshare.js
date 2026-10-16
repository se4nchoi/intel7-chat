// ============================================================
// BambooChat: Discord-Style Multi-Channel & DM Screen Sharing Engine
// WebRTC Mesh + Pan/Zoom + PiP + Insecure Origin Helper
// ============================================================

import { state } from './state.js';
import { showToast, copyText } from './utils.js';
import { sendWebSocketMessage } from './ws.js';
import { channelsDirectory, renderChannels } from './channels.js';
import { displayNickname } from './dm.js';
import { initScreenShareLayout, updateScreenShareLayout } from './screenshare_layout.js';

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

// --- Slide Quality ---
// Every viewer gets the same 1080p-capable ceiling. Do not divide a fixed
// classroom budget by audience size: joining viewers must not lower detail.
// Mesh upload still grows with the audience; prefer dropping fps under load.
const SS_MAX_PER_VIEWER = 4_000_000;
const SS_MAX_FPS = 15;

// Prefer H.264 so the presenter can use the GPU's hardware encoder instead of
// running one software VP8 encoder per viewer. Codecs are only REORDERED (never
// removed), so peers without H.264 still negotiate VP8/VP9 as before, and
// Chrome falls back to software H.264 if the hardware encoder can't open.
// Set to false to restore the browser default codec order.
const SS_PREFER_H264 = true;

function preferH264(pc) {
  if (!SS_PREFER_H264) return;
  try {
    const caps = globalThis.RTCRtpSender?.getCapabilities?.('video');
    if (!caps?.codecs?.length) return;
    const rank = (c) => {
      if (c.mimeType.toLowerCase() !== 'video/h264') return 2;
      const fmtp = c.sdpFmtpLine || '';
      // packetization-mode=1 + constrained baseline: broadest HW encoder support
      if (fmtp.includes('packetization-mode=1') && fmtp.includes('profile-level-id=42e0')) return 0;
      return 1;
    };
    const ordered = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    if (rank(ordered[0]) === 2) return; // browser has no H.264 at all
    for (const t of pc.getTransceivers?.() || []) {
      if (t.sender?.track?.kind === 'video' && typeof t.setCodecPreferences === 'function') {
        t.setCodecPreferences(ordered);
      }
    }
  } catch (err) {
    console.debug('Screen-share codec preference unavailable:', err);
  }
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
  pendingCandidates: new Map(),
  signalQueues: new Map(),
  joinTimer: null,
  retryTimer: null,
  joinAttempts: 0,
  playbackState: 'idle',
  presentingTitle: '',
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
let connectionStatusEl = null;
let connectionMessageEl = null;
let connectionRetryBtn = null;

function setPlaybackState(value) {
  screenshareState.playbackState = value;
  updateUIForCurrentRoom();
}

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
  connectionStatusEl = document.getElementById('ss-connection-status');
  connectionMessageEl = document.getElementById('ss-connection-message');
  connectionRetryBtn = document.getElementById('ss-connection-retry');
  connectionRetryBtn?.addEventListener('click', () => {
    if (screenshareState.playbackState === 'blocked') {
      videoEl?.play().catch(() => setPlaybackState('blocked'));
      return;
    }
    const roomId = getCurrentRoomId();
    if (roomId) joinScreenShare(roomId, { force: true });
  });
  videoEl?.addEventListener('playing', () => {
    if (!screenshareState.viewingChannelId || !videoEl.srcObject) return;
    clearTimeout(screenshareState.joinTimer);
    clearTimeout(screenshareState.retryTimer);
    screenshareState.joinAttempts = 0;
    setPlaybackState('playing');
  });

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
      updateScreenShareLayout(true, screenshareState.isCollapsed);
      if (!screenshareState.isCollapsed) showScreenControls();
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
  initScreenShareLayout();
  initControlsAutohide();

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
      videoEl?.play().catch(err => console.warn('Screen-share playback blocked:', err));
      screenshareState.isCollapsed = !screenshareState.isCollapsed;
      panelContainer?.classList.toggle('collapsed', screenshareState.isCollapsed);
      if (toggleViewBtn) toggleViewBtn.textContent = screenshareState.isCollapsed ? '펼치기' : '접기';
      updateScreenShareLayout(true, screenshareState.isCollapsed);
      if (!screenshareState.isCollapsed) showScreenControls();
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
    // Request up to 1080p for slide text; sources smaller than this stay native.
    // 15 fps is a ceiling, not a target to preserve at the expense of detail.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: SS_MAX_FPS, max: SS_MAX_FPS }
      },
      audio: false,
    });

    if (screenshareState.presentingChannelId) stopScreenShare(screenshareState.presentingChannelId);

    screenshareState.localStream = stream;
    screenshareState.presentingChannelId = normId;

    // Handle user stopping stream via browser native bar ("Stop sharing")
    const track = stream.getVideoTracks()[0];
    if (track) {
      // Slide readability takes priority over animation smoothness.
      try { if ('contentHint' in track) track.contentHint = 'detail'; } catch {}
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
    screenshareState.presentingTitle = title;
    const sent = sendWebSocketMessage({
      type: 'screenshare_start',
      channel_id: isDm ? normId : Number(normId),
      title: title,
    });
    if (!sent) {
      resetScreenShare();
      return;
    }

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

    closePeerConnections('presenter', normId);
    showToast('화면 공유가 종료되었습니다.', 'info');
  }

  // If viewing
  if (normalizeRoomKey(screenshareState.viewingChannelId) === normId) {
    leaveScreenShare(normId);
  }

  updateUIForCurrentRoom();
}

// --- Viewer Workflow ---
export function joinScreenShare(roomId, { force = false } = {}) {
  const normId = normalizeRoomKey(roomId);
  if (!normId || !screenshareState.hasSession(normId) ||
      normalizeRoomKey(screenshareState.presentingChannelId) === normId) return;
  if (!force && screenshareState.viewingChannelId === normId) return;
  if (!force || screenshareState.playbackState === 'failed') screenshareState.joinAttempts = 0;
  if (screenshareState.viewingChannelId && screenshareState.viewingChannelId !== normId) {
    leaveScreenShare(screenshareState.viewingChannelId);
  }
  closePeerConnections('viewer', normId);
  clearTimeout(screenshareState.joinTimer);
  clearTimeout(screenshareState.retryTimer);
  if (videoEl) videoEl.srcObject = null;

  const isDm = String(normId).startsWith('dm:');
  const sent = sendWebSocketMessage({
    type: 'screenshare_join',
    channel_id: isDm ? normId : Number(normId),
  });
  if (!sent) {
    screenshareState.viewingChannelId = null;
    setPlaybackState('offline');
    return;
  }
  screenshareState.viewingChannelId = normId;
  screenshareState.isCollapsed = false;
  screenshareState.playbackState = force ? 'reconnecting' : 'connecting';
  clearTimeout(screenshareState.joinTimer);
  screenshareState.joinTimer = setTimeout(() => retryViewing(normId), 12000);

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
    clearTimeout(screenshareState.joinTimer);
    clearTimeout(screenshareState.retryTimer);
    screenshareState.joinAttempts = 0;
    screenshareState.playbackState = 'idle';
    closePeerConnections('viewer', normId);
    if (videoEl) {
      videoEl.srcObject = null;
    }
  }

  updateUIForCurrentRoom();
}


// --- PeerConnection Cleanup ---
function closeAllPeerConnections() {
  closePeerConnections();
  screenshareState.pendingCandidates.clear();
  screenshareState.signalQueues.clear();
}

function closePeerConnections(role, roomId) {
  for (const [key, pc] of screenshareState.peerConnections) {
    if ((!role || pc.ss.role === role) && (!roomId || pc.ss.roomId === roomId)) {
      clearTimeout(pc.ss.timer);
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      screenshareState.peerConnections.delete(key);
      screenshareState.pendingCandidates.delete(key);
    }
  }
  for (const key of screenshareState.pendingCandidates.keys()) {
    const prefix = role ? `${role}:${roomId || ''}` : null;
    if ((!role || key.startsWith(prefix)) && (!roomId || key.includes(`:${roomId}:`))) {
      screenshareState.pendingCandidates.delete(key);
    }
  }
}

function retryViewing(roomId) {
  if (screenshareState.viewingChannelId !== roomId || !screenshareState.hasSession(roomId)) return;
  clearTimeout(screenshareState.joinTimer);
  clearTimeout(screenshareState.retryTimer);
  if (screenshareState.joinAttempts >= 3) {
    showToast('화면 연결에 실패했습니다. 화면 공유 버튼을 눌러 다시 연결해 주세요.', 'warning');
    screenshareState.viewingChannelId = null;
    closePeerConnections('viewer', roomId);
    if (videoEl) videoEl.srcObject = null;
    screenshareState.playbackState = 'failed';
    updateUIForCurrentRoom();
    return;
  }
  screenshareState.joinAttempts++;
  setPlaybackState('reconnecting');
  screenshareState.retryTimer = setTimeout(() => joinScreenShare(roomId, { force: true }), 2000);
}

function peerKey(role, roomId, userId, clientId) {
  return `${role}:${roomId}:${clientId || userId}`;
}

function sendPeerSignal(pc, signal) {
  if (screenshareState.peerConnections.get(pc.ss.key) !== pc) return;
  sendWebSocketMessage({
    type: 'screenshare_signal', channel_id: pc.ss.roomId,
    target_user_id: pc.ss.userId, target_client_id: pc.ss.clientId,
    session_id: pc.ss.sessionId, connection_id: pc.ss.connectionId, signal,
  });
}

function createPeer(role, roomId, userId, clientId, sessionId, connectionId) {
  const key = peerKey(role, roomId, userId, clientId);
  const old = screenshareState.peerConnections.get(key);
  if (old) {
    clearTimeout(old.ss.timer);
    old.onconnectionstatechange = null;
    old.close();
  }
  // Keep the original connectivity fallback: host candidates alone are not
  // sufficient on every classroom browser/network configuration.
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.ss = { key, role, roomId, userId, clientId, sessionId, connectionId, timer: null };
  screenshareState.peerConnections.set(key, pc);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendPeerSignal(pc, { type: 'candidate', candidate });
  };
  pc.onconnectionstatechange = () => {
    if (screenshareState.peerConnections.get(key) !== pc) return;
    console.info('Screen-share connection', { roomId, userId, state: pc.connectionState, ice: pc.iceConnectionState });
    if (pc.connectionState === 'connected') {
      clearTimeout(pc.ss.timer);
      if (role === 'viewer') {
        // Transport connectivity does not guarantee a decoded/playing frame.
        // Keep the join watchdog until the video element reports playback.
        if (videoEl?.readyState >= 2 && !videoEl.paused && videoEl.srcObject) {
          clearTimeout(screenshareState.joinTimer);
          clearTimeout(screenshareState.retryTimer);
          setPlaybackState('playing');
        } else if (screenshareState.playbackState !== 'playing') setPlaybackState('waiting');
      }
      updateUIForCurrentRoom();
    } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
      if (role === 'viewer') setPlaybackState('reconnecting');
      clearTimeout(pc.ss.timer);
      pc.ss.timer = setTimeout(() => {
        if (role === 'viewer') retryViewing(roomId);
      }, pc.connectionState === 'failed' ? 0 : 5000);
    }
  };
  return pc;
}

async function flushCandidates(pc) {
  const pending = screenshareState.pendingCandidates.get(pc.ss.key) || [];
  screenshareState.pendingCandidates.delete(pc.ss.key);
  for (const { candidate, connectionId } of pending) {
    if (connectionId && connectionId !== pc.ss.connectionId) continue;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

// --- WebRTC Signaling Handlers ---
export async function handleViewerJoined({ channel_id, viewer_user_id, viewer_client_id, session_id }) {
  const normId = normalizeRoomKey(channel_id);
  // Only the active presenter handles new viewers
  if (normalizeRoomKey(screenshareState.presentingChannelId) !== normId || !screenshareState.localStream) return;

  const targetId = Number(viewer_user_id);
  const pc = createPeer('presenter', normId, targetId, viewer_client_id, session_id,
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);

  // Add local display tracks
  screenshareState.localStream.getTracks().forEach(track => {
    pc.addTrack(track, screenshareState.localStream);
  });

  try {
    preferH264(pc);
    await tunePresenterSender(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendPeerSignal(pc, { type: 'offer', sdp: offer.sdp });
  } catch (err) {
    console.error('Failed to create offer for viewer:', err);
  }
}

export function handleViewerLeft({ channel_id, viewer_user_id, viewer_client_id }) {
  const normId = normalizeRoomKey(channel_id);
  if (normalizeRoomKey(screenshareState.presentingChannelId) !== normId) return;

  const targetId = Number(viewer_user_id);
  const key = peerKey('presenter', normId, targetId, viewer_client_id);
  const pc = screenshareState.peerConnections.get(key);
  if (pc) {
    try { pc.close(); } catch {}
    clearTimeout(pc.ss.timer);
    pc.onconnectionstatechange = null;
    screenshareState.peerConnections.delete(key);
    screenshareState.pendingCandidates.delete(key);
  }
}

async function tunePresenterSender(pc) {
  for (const sender of pc.getSenders?.() || []) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings.forEach(encoding => {
        encoding.maxBitrate = SS_MAX_PER_VIEWER;
        encoding.maxFramerate = SS_MAX_FPS;
        encoding.scaleResolutionDownBy = 1;
      });
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    } catch (err) {
      console.debug('Screen-share sender tuning unavailable:', err);
    }
  }
}

export function handleSignal(data) {
  const roomId = normalizeRoomKey(data.channel_id);
  const role = normalizeRoomKey(screenshareState.presentingChannelId) === roomId ? 'presenter' : 'viewer';
  const key = peerKey(role, roomId, Number(data.from_user_id), data.from_client_id);
  const previous = screenshareState.signalQueues.get(key) || Promise.resolve();
  const current = previous.then(() => processSignal(data, role, key)).catch(err => {
    console.warn('Screen-share signaling failed:', err);
    if (role === 'viewer') retryViewing(roomId);
  });
  screenshareState.signalQueues.set(key, current);
  current.finally(() => {
    if (screenshareState.signalQueues.get(key) === current) screenshareState.signalQueues.delete(key);
  });
  return current;
}

async function processSignal({ channel_id, from_user_id, from_client_id, session_id, connection_id, signal }, role, key) {
  const senderId = Number(from_user_id);
  const roomId = normalizeRoomKey(channel_id);
  const session = screenshareState.getSession(roomId);
  if (!signal || !session || (session_id && session_id !== session.session_id)) return;
  if (role === 'viewer' && (screenshareState.viewingChannelId !== roomId || Number(session.user_id) !== senderId)) return;

  // Viewer receives Offer from Presenter
  if (signal.type === 'offer') {
    if (role !== 'viewer') return;
    const pc = createPeer('viewer', roomId, senderId, from_client_id, session_id, connection_id);

    pc.ontrack = (event) => {
      if (screenshareState.peerConnections.get(key) === pc && getCurrentRoomId() === roomId && videoEl && event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        // Optional browser hint: favor interactive latency over a deep buffer.
        try {
          if (event.receiver && 'jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 50;
        } catch (err) { console.debug('Screen-share buffer tuning unavailable:', err); }
        setPlaybackState('waiting');
        videoEl.muted = true;
        videoEl.play().catch(err => {
          console.warn('Screen-share playback blocked:', err);
          if (screenshareState.peerConnections.get(key) !== pc) return;
          clearTimeout(screenshareState.joinTimer);
          setPlaybackState('blocked');
          showToast('화면 재생이 차단되었습니다. 화면 공유 버튼을 다시 눌러 주세요.', 'warning');
        });
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
      await flushCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendPeerSignal(pc, { type: 'answer', sdp: answer.sdp });
    } catch (err) {
      console.error('Failed to process offer / send answer:', err);
      retryViewing(roomId);
    }
    return;
  }

  // Presenter receives Answer from Viewer
  if (signal.type === 'answer') {
    const pc = screenshareState.peerConnections.get(key);
    if (connection_id && pc?.ss.connectionId !== connection_id) return;
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
        await flushCandidates(pc);
        // Some browsers expose usable encoding parameters only after negotiation.
        if (role === 'presenter') await tunePresenterSender(pc);
      } catch (err) {
        console.error('Failed to set remote answer:', err);
      }
    }
    return;
  }

  // ICE Candidate
  if (signal.type === 'candidate' && signal.candidate) {
    const pc = screenshareState.peerConnections.get(key);
    if (pc && connection_id && pc.ss.connectionId !== connection_id) return;
    if (!pc || !pc.remoteDescription) {
      const pending = screenshareState.pendingCandidates.get(key) || [];
      if (pending.length < 64) pending.push({ candidate: signal.candidate, connectionId: connection_id });
      screenshareState.pendingCandidates.set(key, pending);
    } else {
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
  const previous = screenshareState.getSession(roomId);
  if (previous && previous.session_id !== data.session_id) {
    closePeerConnections(undefined, roomId);
    if (screenshareState.viewingChannelId === roomId) screenshareState.viewingChannelId = null;
  }
  screenshareState.activeSessions.set(roomId, {
    ...data,
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
  const session = screenshareState.getSession(roomId);
  if (data.session_id && session && session.session_id !== data.session_id) return;
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
    closePeerConnections('presenter', roomId);
  }

  if (normalizeRoomKey(screenshareState.viewingChannelId) === roomId) {
    screenshareState.viewingChannelId = null;
    if (videoEl) videoEl.srcObject = null;
    clearTimeout(screenshareState.joinTimer);
    clearTimeout(screenshareState.retryTimer);
    closePeerConnections('viewer', roomId);
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
  const previous = new Map(screenshareState.activeSessions);
  screenshareState.activeSessions.clear();
  if (sessionsMap && typeof sessionsMap === 'object') {
    Object.entries(sessionsMap).forEach(([ridStr, s]) => {
      const rid = normalizeRoomKey(s.channel_id || ridStr);
      screenshareState.activeSessions.set(rid, {
        ...s,
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
  for (const [rid, oldSession] of previous) {
    const session = screenshareState.getSession(rid);
    if (!session || session.session_id !== oldSession.session_id) {
      closePeerConnections(undefined, rid);
      if (screenshareState.viewingChannelId === rid) screenshareState.viewingChannelId = null;
    }
  }
  const presentingRoom = screenshareState.presentingChannelId;
  if (presentingRoom && screenshareState.localStream?.getVideoTracks().some(track => track.readyState === 'live')) {
    sendWebSocketMessage({ type: 'screenshare_start', channel_id: presentingRoom,
      title: screenshareState.presentingTitle });
  }
  renderChannels(window.bambooChatSwitchChannel);
  window.bambooChatRenderDms?.();
  updateUIForCurrentRoom();
  const roomId = getCurrentRoomId();
  if (roomId && screenshareState.hasSession(roomId) && roomId !== presentingRoom) joinScreenShare(roomId);
}

export function onScreenshareDisconnected() {
  clearTimeout(screenshareState.joinTimer);
  clearTimeout(screenshareState.retryTimer);
  closeAllPeerConnections();
  screenshareState.viewingChannelId = null;
  screenshareState.joinAttempts = 0;
  screenshareState.playbackState = 'offline';
  if (!screenshareState.localStream && videoEl) videoEl.srcObject = null;
  updateUIForCurrentRoom();
}

export function resetScreenShare() {
  onScreenshareDisconnected();
  screenshareState.localStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  screenshareState.localStream = null;
  screenshareState.presentingChannelId = null;
  screenshareState.presentingTitle = '';
  screenshareState.activeSessions.clear();
  screenshareState.playbackState = 'idle';
  if (videoEl) videoEl.srcObject = null;
  const viewport = document.getElementById('ss-viewport');
  viewport?.classList.remove('ss-controls-hidden');
  updateUIForCurrentRoom();
}

export function handleScreenshareError(data) {
  const roomId = normalizeRoomKey(data.channel_id);
  if (data.request_type === 'screenshare_start' && screenshareState.presentingChannelId === roomId) {
    screenshareState.localStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    screenshareState.localStream = null;
    screenshareState.presentingChannelId = null;
    closePeerConnections('presenter', roomId);
    if (videoEl) videoEl.srcObject = null;
  } else if (data.request_type === 'screenshare_join' && screenshareState.viewingChannelId === roomId) {
    leaveScreenShare(roomId);
  }
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
  const videoConnected = [...screenshareState.peerConnections.values()].some(pc =>
    pc.ss.role === 'viewer' && pc.ss.roomId === currentRoomId && pc.connectionState === 'connected');
  const isLive = Boolean(session);
  updateScreenShareLayout(isLive || isPresentingHere, screenshareState.isCollapsed);
  if (connectionStatusEl) {
    const status = screenshareState.playbackState;
    const show = isLive && !isPresentingHere && status !== 'playing';
    connectionStatusEl.classList.toggle('hidden', !show);
    connectionStatusEl.classList.toggle('is-pending', ['connecting', 'waiting', 'reconnecting'].includes(status));
    if (connectionMessageEl) connectionMessageEl.textContent = ({
      connecting: '화면 공유에 연결하고 있습니다…',
      waiting: '연결되었습니다. 첫 화면을 기다리고 있습니다…',
      reconnecting: '연결이 지연되어 다시 연결하고 있습니다…',
      failed: '화면을 연결하지 못했습니다. 같은 네트워크와 방화벽 설정을 확인한 후 다시 시도해 주세요.',
      blocked: '화면 재생을 시작하려면 아래 버튼을 눌러 주세요.',
      offline: '서버 연결이 끊겼습니다. 다시 연결되면 화면 공유를 복구합니다.',
    })[status] || '화면 공유를 준비하고 있습니다…';
    if (connectionRetryBtn) {
      connectionRetryBtn.classList.toggle('hidden', !['failed', 'blocked'].includes(status));
      connectionRetryBtn.textContent = status === 'blocked' ? '화면 재생' : '다시 연결';
    }
  }

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
      if (labelEl) labelEl.textContent = videoConnected ? '🔴 방송 시청 중' : (isViewingHere ? '🔴 방송 연결 중' : '🔴 방송 보기');
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
    const viewport = document.getElementById('ss-viewport');
    viewport?.classList.remove('ss-controls-hidden');
    return;
  }

  // Show panel
  if (isPresentingHere && videoEl && videoEl.srcObject !== screenshareState.localStream) {
    videoEl.srcObject = screenshareState.localStream;
    videoEl.muted = true;
    videoEl.play().catch(err => console.warn('Screen-share preview blocked:', err));
  }
  panelContainer.classList.remove('hidden');
  panelContainer.classList.toggle('collapsed', screenshareState.isCollapsed);
  if (!screenshareState.isCollapsed) {
    showScreenControls();
  }

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
      pingControls();
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

// --- Screen Controls Autohide / Show Engine ---
let pingControls = () => {};

export function showScreenControls() {
  pingControls();
}

function initControlsAutohide() {
  const viewport = document.getElementById('ss-viewport');
  const toolbar = document.getElementById('ss-floating-toolbar') || viewport?.querySelector?.('.ss-floating-toolbar');
  if (!viewport || !toolbar) return;

  let hideTimer = null;
  let isToolbarHovered = false;
  let isToolbarFocused = false;
  const AUTOHIDE_DELAY = 2500;

  function showControls() {
    viewport.classList.remove('ss-controls-hidden');
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function scheduleHide(delay = AUTOHIDE_DELAY) {
    clearTimeout(hideTimer);
    if (isToolbarHovered || isToolbarFocused || screenshareState.isPanning) {
      return;
    }
    hideTimer = setTimeout(() => {
      if (isToolbarHovered || isToolbarFocused || screenshareState.isPanning) {
        return;
      }
      viewport.classList.add('ss-controls-hidden');
    }, delay);
  }

  function onActivity() {
    showControls();
    scheduleHide();
  }

  pingControls = onActivity;

  // Pointer & mouse activity within viewport
  viewport.addEventListener('pointerenter', onActivity);
  viewport.addEventListener('pointermove', onActivity);
  viewport.addEventListener('pointerdown', onActivity);
  viewport.addEventListener('wheel', onActivity, { passive: true });

  // When leaving the viewport, hide after a short delay
  viewport.addEventListener('pointerleave', () => {
    if (!isToolbarFocused) {
      scheduleHide(800);
    }
  });

  // When hovering on toolbar itself, keep it visible unconditionally
  toolbar.addEventListener('pointerenter', () => {
    isToolbarHovered = true;
    showControls();
  });
  toolbar.addEventListener('pointerleave', () => {
    isToolbarHovered = false;
    scheduleHide();
  });

  // Keyboard navigation / focus within toolbar keeps it visible
  toolbar.addEventListener('focusin', () => {
    isToolbarFocused = true;
    showControls();
  });
  toolbar.addEventListener('focusout', () => {
    isToolbarFocused = false;
    scheduleHide();
  });

  // Fullscreen change & key activity
  document?.addEventListener?.('fullscreenchange', onActivity);
  document?.addEventListener?.('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (document.fullscreenElement || document.querySelector?.('.chat-area.ss-theatre')) {
      onActivity();
    }
  });

  scheduleHide();
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
