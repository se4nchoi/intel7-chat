// Run: node --experimental-vm-modules scripts/test_screenshare.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../app/static/js/screenshare.js', import.meta.url), 'utf8');

async function setup() {
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const state = { activeRoom: { type: 'channel', id: 1 }, currentUser: { id: 2, username: 'viewer' } };
  function element() {
    const classes = new Set();
    const listeners = new Map();
    return {
      textContent: '', listeners,
      classList: {
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
      addEventListener(name, callback) { listeners.set(name, callback); },
    };
  }
  const video = { ...element(), srcObject: null, play: () => Promise.resolve() };
  const status = element(), message = element(), retry = element();
  const elements = {
    'screenshare-video': video, 'screenshare-panel-container': element(),
    'ss-connection-status': status, 'ss-connection-message': message, 'ss-connection-retry': retry,
  };
  const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  class Peer {
    constructor(configuration) {
      this.configuration = configuration;
      this.remoteDescription = null; this.candidates = []; this.connectionState = 'new';
      this.senders = [];
    }
    close() { this.connectionState = 'closed'; }
    addTrack(track) {
      const sender = { track, getParameters: () => ({ encodings: [{}] }),
        async setParameters(parameters) { this.parameters = parameters; } };
      this.senders.push(sender);
    }
    getSenders() { return this.senders; }
    async createOffer() { return { sdp: 'offer' }; }
    async createAnswer() { return { sdp: 'answer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) {
      if (this.remoteGate) await this.remoteGate;
      this.remoteDescription = description;
    }
    async addIceCandidate(candidate) {
      assert.ok(this.remoteDescription, 'ICE must wait for remote description');
      this.candidates.push(candidate);
    }
  }
  let online = true;
  const context = vm.createContext({
    console, RTCPeerConnection: Peer,
    RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
    RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
    window: { location: { origin: 'https://testserver' } }, document: { getElementById: id => elements[id] || null },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const dependencies = {
    './state.js': { state },
    './utils.js': { showToast() {}, copyText() {} },
    './ws.js': { sendWebSocketMessage(payload) { if (online) sent.push(payload); return online; } },
    './channels.js': { channelsDirectory: new Map(), renderChannels() {} },
    './dm.js': { displayNickname: name => name },
  };
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const api = module.namespace;
  api.initScreenShareUI();
  const session = { channel_id: 1, user_id: 1, session_id: 'session', presenter_client_id: 'presenter-tab' };
  return { api, state, sent, timers, video, status, message, retry, stream, track, session, offline: () => { online = false; } };
}

test('late login joins an active share and ignores repeated sync joins', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  h.api.syncAllActiveSessions({ 1: h.session });
  assert.equal(h.api.screenshareState.viewingChannelId, '1');
  assert.equal(h.sent.filter(p => p.type === 'screenshare_join').length, 1);
});

test('candidate before offer is queued and applied after remote description', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  const base = { channel_id: 1, from_user_id: 1, from_client_id: 'presenter-tab', session_id: 'session', connection_id: 'connection' };
  await h.api.handleSignal({ ...base, signal: { type: 'candidate', candidate: { candidate: 'early' } } });
  await h.api.handleSignal({ ...base, signal: { type: 'offer', sdp: 'offer' } });
  const pc = [...h.api.screenshareState.peerConnections.values()][0];
  assert.equal(pc.candidates.length, 1);
  assert.equal(h.sent.at(-1).signal.type, 'answer');
});

test('candidate during answer setup waits; repeated joins close old presenter peers', async () => {
  const h = await setup();
  const s = h.api.screenshareState;
  s.presentingChannelId = '1'; s.localStream = h.stream;
  h.api.onScreenshareStarted(h.session);
  const join = { channel_id: 1, viewer_user_id: 2, viewer_client_id: 'viewer-tab', session_id: 'session' };
  await h.api.handleViewerJoined(join);
  const old = [...s.peerConnections.values()][0];
  await h.api.handleViewerJoined(join);
  assert.equal(old.connectionState, 'closed');
  const pc = [...s.peerConnections.values()][0];
  let release;
  pc.remoteGate = new Promise(resolve => { release = resolve; });
  const base = { channel_id: 1, from_user_id: 2, from_client_id: 'viewer-tab', session_id: 'session', connection_id: pc.ss.connectionId };
  const answer = h.api.handleSignal({ ...base, signal: { type: 'answer', sdp: 'answer' } });
  const candidate = h.api.handleSignal({ ...base, signal: { type: 'candidate', candidate: { candidate: 'during-answer' } } });
  release(); await Promise.all([answer, candidate]);
  assert.equal(pc.candidates.length, 1);
});

test('disconnect and sync restore viewer join and presenter announcement', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  h.api.onScreenshareDisconnected();
  h.api.syncAllActiveSessions({ 1: h.session });
  assert.equal(h.sent.filter(p => p.type === 'screenshare_join').length, 2);
  h.api.screenshareState.presentingChannelId = '2';
  h.api.screenshareState.localStream = h.stream;
  h.api.onScreenshareDisconnected();
  h.api.syncAllActiveSessions({});
  assert.ok(h.sent.some(p => p.type === 'screenshare_start' && p.channel_id === '2'));
  assert.equal(h.track.readyState, 'live');
});

test('offline join does not claim viewing; logout stops capture and cleans peers', async () => {
  const h = await setup();
  h.offline(); h.api.syncAllActiveSessions({ 1: h.session });
  assert.equal(h.api.screenshareState.viewingChannelId, null);
  h.api.screenshareState.localStream = h.stream;
  h.api.resetScreenShare();
  assert.equal(h.track.readyState, 'ended');
  assert.equal(h.api.screenshareState.peerConnections.size, 0);
  assert.equal(h.timers.size, 0);
});

test('leaving viewed room preserves outbound presenter peers; stop cleans them', async () => {
  const h = await setup();
  const s = h.api.screenshareState;
  s.presentingChannelId = '1'; s.localStream = h.stream;
  h.api.onScreenshareStarted(h.session);
  await h.api.handleViewerJoined({ channel_id: 1, viewer_user_id: 2, viewer_client_id: 'viewer-tab', session_id: 'session' });
  const pc = [...s.peerConnections.values()][0];
  s.viewingChannelId = '2'; h.api.leaveScreenShare(2);
  assert.notEqual(pc.connectionState, 'closed');
  h.api.onScreenshareStopped({ channel_id: 1, session_id: 'session' });
  assert.equal(pc.connectionState, 'closed');
  assert.equal(h.track.readyState, 'ended');
});

test('connection overlay stays until playback, with first-frame watchdog after transport connects', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  assert.equal(h.status.classList.contains('hidden'), false);
  assert.match(h.message.textContent, /연결하고/);
  await h.api.handleSignal({ channel_id: 1, from_user_id: 1, from_client_id: 'presenter-tab',
    session_id: 'session', connection_id: 'connection', signal: { type: 'offer', sdp: 'offer' } });
  const pc = [...h.api.screenshareState.peerConnections.values()][0];
  assert.equal(pc.configuration.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  pc.connectionState = 'connected'; pc.onconnectionstatechange();
  assert.equal(h.timers.size, 1, 'transport must not clear the first-frame timeout');
  const receiver = { jitterBufferTarget: null };
  pc.ontrack({ streams: [h.stream], receiver });
  assert.equal(receiver.jitterBufferTarget, 50);
  assert.equal(h.status.classList.contains('hidden'), false);
  h.video.listeners.get('playing')();
  assert.equal(h.status.classList.contains('hidden'), true);
  assert.equal(h.timers.size, 0);
});

test('retry exhaustion shows persistent recovery button, manual retry resets budget', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  h.api.screenshareState.joinAttempts = 3;
  const watchdog = [...h.timers.values()][0];
  watchdog();
  assert.equal(h.api.screenshareState.playbackState, 'failed');
  assert.equal(h.retry.classList.contains('hidden'), false);
  h.retry.listeners.get('click')();
  assert.equal(h.api.screenshareState.joinAttempts, 0);
  assert.equal(h.api.screenshareState.viewingChannelId, '1');
  assert.equal(h.retry.classList.contains('hidden'), true);
});

test('blocked playback can be resumed without rebuilding the peer', async () => {
  const h = await setup();
  h.api.syncAllActiveSessions({ 1: h.session });
  await h.api.handleSignal({ channel_id: 1, from_user_id: 1, from_client_id: 'presenter-tab',
    session_id: 'session', signal: { type: 'offer', sdp: 'offer' } });
  const pc = [...h.api.screenshareState.peerConnections.values()][0];
  h.video.play = () => Promise.reject(new Error('autoplay blocked'));
  pc.ontrack({ streams: [h.stream] });
  await Promise.resolve();
  assert.equal(h.api.screenshareState.playbackState, 'blocked');
  assert.equal(h.timers.size, 0);
  const sentCount = h.sent.length;
  h.video.play = () => Promise.resolve();
  h.retry.listeners.get('click')();
  assert.equal(h.sent.length, sentCount);
  assert.equal(h.video.srcObject, h.stream);
  h.video.listeners.get('playing')();
  assert.equal(h.status.classList.contains('hidden'), true);
});

test('presenter caps each video sender; disconnect displays recovery status', async () => {
  const h = await setup();
  const s = h.api.screenshareState;
  s.presentingChannelId = '1'; s.localStream = h.stream;
  h.api.onScreenshareStarted(h.session);
  await h.api.handleViewerJoined({ channel_id: 1, viewer_user_id: 2, viewer_client_id: 'viewer-tab', session_id: 'session' });
  const pc = [...s.peerConnections.values()][0];
  assert.equal(pc.senders[0].parameters.encodings[0].maxBitrate, 1_500_000);
  assert.equal(pc.senders[0].parameters.encodings[0].maxFramerate, 15);
  s.presentingChannelId = null; s.localStream = null;
  h.api.onScreenshareDisconnected();
  assert.equal(h.status.classList.contains('hidden'), false);
  assert.match(h.message.textContent, /서버 연결이 끊겼/);
});

test('classroom viewers share the presenter upload budget and reclaim it after leaving', async () => {
  const h = await setup();
  const s = h.api.screenshareState;
  s.presentingChannelId = '1'; s.localStream = h.stream;
  h.api.onScreenshareStarted(h.session);
  for (let i = 0; i < 23; i++) {
    await h.api.handleViewerJoined({ channel_id: 1, viewer_user_id: i + 2,
      viewer_client_id: `viewer-${i}`, session_id: 'session' });
  }
  const bitrate = pc => pc.senders[0].parameters.encodings[0].maxBitrate;
  const peers = [...s.peerConnections.values()];
  assert.ok(peers.reduce((sum, pc) => sum + bitrate(pc), 0) <= 20_000_023);
  const before = bitrate(peers[0]);
  h.api.handleViewerLeft({ channel_id: 1, viewer_user_id: 24, viewer_client_id: 'viewer-22' });
  // Wait for the asynchronous sender updates to settle.
  for (let i = 0; i < 25; i++) await Promise.resolve();
  assert.ok(bitrate(peers[0]) > before);
  assert.equal(s.peerConnections.size, 22);
});
