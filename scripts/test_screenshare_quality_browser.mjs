// Optional native WebRTC test; requires Playwright and Chromium.
// Supports PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE like the layout browser test.
// Uses synthetic 1080p canvas content and isolated in-browser signaling, no app server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const source = await readFile(new URL('../app/static/js/screenshare.js', import.meta.url), 'utf8');
const stubs = {
  'state.js': "export const state={activeRoom:{type:'channel',id:1},currentUser:{id:1,username:'presenter'}};",
  'utils.js': 'export function showToast(){} export function copyText(){}',
  'ws.js': 'export function sendWebSocketMessage(value){window.relay?.(value).catch(e=>window.bridgeError=String(e));return true;}',
  'channels.js': 'export const channelsDirectory=new Map();export function renderChannels(){}',
  'dm.js': 'export const displayNickname=value=>value;',
  'screenshare_layout.js': 'export function initScreenShareLayout(){} export function updateScreenShareLayout(){}',
};
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true,
  args: ['--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
try {
  const page = await browser.newPage();
  await page.route('http://screenshare.test/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html',
      body: name === 'screenshare.js' ? source : stubs[name] || '<video id="screenshare-video" muted autoplay></video><video id="received" muted autoplay></video>' });
  });
  await page.goto('http://screenshare.test/');
  await page.evaluate(async () => {
    const app = await import('/screenshare.js');
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const context = canvas.getContext('2d');
    let count = 0;
    const draw = () => {
      context.fillStyle = 'white'; context.fillRect(0, 0, 1920, 1080);
      context.fillStyle = 'black'; context.font = '32px Arial';
      context.fillText(`Classroom slide quality test ${count++}`, 60, 90);
      requestAnimationFrame(draw);
    };
    draw();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: async () => canvas.captureStream(15) } });
    app.initScreenShareUI();
    await app.startScreenShare(1);
    app.onScreenshareStarted({ channel_id: 1, user_id: 1, session_id: 'quality-session' });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    window.qualityReceiver = receiver;
    const pending = [];
    const fromViewer = signal => {
      const pc = [...app.screenshareState.peerConnections.values()][0];
      return app.handleSignal({ channel_id: 1, from_user_id: 2, from_client_id: 'viewer',
        session_id: 'quality-session', connection_id: pc.ss.connectionId, signal });
    };
    receiver.onicecandidate = event => {
      if (event.candidate) fromViewer({ type: 'candidate', candidate: event.candidate }).catch(error => window.bridgeError = String(error));
    };
    receiver.ontrack = event => { document.getElementById('received').srcObject = event.streams[0]; };
    window.relay = async message => {
      if (message.type !== 'screenshare_signal') return;
      if (message.signal.type === 'offer') {
        await receiver.setRemoteDescription({ type: 'offer', sdp: message.signal.sdp });
        for (const candidate of pending.splice(0)) await receiver.addIceCandidate(candidate);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await fromViewer({ type: 'answer', sdp: receiver.localDescription.sdp });
      } else if (message.signal.type === 'candidate') {
        if (!receiver.remoteDescription) pending.push(message.signal.candidate);
        else await receiver.addIceCandidate(message.signal.candidate);
      }
    };
    window.qualityApp = app;
    await app.handleViewerJoined({ channel_id: 1, viewer_user_id: 2, viewer_client_id: 'viewer', session_id: 'quality-session' });
  });
  try {
    await page.waitForFunction(() => window.bridgeError || document.getElementById('received').videoHeight === 1080, null, { timeout: 15000 });
  } catch (error) {
    console.error(await page.evaluate(async () => {
      const pc = [...window.qualityApp.screenshareState.peerConnections.values()][0];
      const stats = [...(await pc.getStats()).values()];
      return { state: pc.connectionState, ice: pc.iceConnectionState,
        capture: pc.getSenders()[0].track.getSettings(),
        video: stats.filter(row => ['outbound-rtp', 'codec'].includes(row.type)) };
    }));
    throw error;
  }
  const result = await page.evaluate(() => {
    const video = document.getElementById('received');
    const pc = [...window.qualityApp.screenshareState.peerConnections.values()][0];
    return { error: window.bridgeError, width: video.videoWidth, height: video.videoHeight,
      parameters: pc.getSenders()[0].getParameters(), hint: pc.getSenders()[0].track.contentHint };
  });
  assert.equal(result.error, undefined);
  assert.equal(result.width, 1920); assert.equal(result.height, 1080);
  assert.equal(result.hint, 'detail');
  assert.equal(result.parameters.degradationPreference, 'maintain-resolution');
  assert.equal(result.parameters.encodings[0].maxBitrate, 4_000_000);
  assert.equal(result.parameters.encodings[0].scaleResolutionDownBy, 1);
  console.log('PASS: native WebRTC receiver decoded 1920×1080 with resolution-first sender settings');
} finally { await browser.close(); }
