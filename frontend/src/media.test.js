import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassroomMedia } from './media.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ token, join, picker } = {}) {
  const rooms = [], phases = [], tracks = [], captures = [];
  class Room {
    constructor(options) {
      this.options = options;
      this.events = {};
      this.disconnected = 0;
      this.localParticipant = {
        setScreenShareEnabled: async (...args) => {
          captures.push(args);
          if (args[0] && picker) await picker.promise;
        },
      };
      rooms.push(this);
    }
    on(event, listener) { this.events[event] = listener; }
    async connect() { if (join) await join.promise; }
    async disconnect() { this.disconnected++; this.events.disconnected?.(); }
  }
  const sdk = {
    Room, VideoQuality: { HIGH: 'high' },
    Track: { Kind: { Video: 'video' }, Source: { ScreenShare: 'screen' } },
    RoomEvent: Object.fromEntries(['TrackSubscribed', 'TrackUnsubscribed', 'Reconnecting', 'Reconnected', 'Disconnected', 'LocalTrackUnpublished'].map(key => [key, key === 'Disconnected' ? 'disconnected' : key])),
  };
  const media = new ClassroomMedia({
    loadSdk: async () => sdk,
    token: token || (async () => ({ url: 'wss://academy/media', token: 'private' })),
    onState: phase => phases.push(phase), onTrack: track => tracks.push(track),
  });
  return { media, rooms, phases, tracks, captures };
}

test('reports connecting immediately, ignores duplicate joins, and clears pending joins on cancel', async () => {
  const pending = deferred();
  const h = harness({ token: () => pending.promise });
  const connecting = h.media.connect(1, 2);
  assert.equal(h.phases.at(-1), 'connecting');
  await h.media.connect(1, 2);
  await h.media.leave();
  pending.resolve({ url: 'wss://academy', token: 'private' });
  await connecting;
  assert.equal(h.rooms.length, 0);
  assert.equal(h.phases.at(-1), 'idle');
});

test('channel change closes a join already in progress and permits a fresh room', async () => {
  const join = deferred(), h = harness({ join });
  const connecting = h.media.connect(1, 2);
  await new Promise(resolve => setImmediate(resolve));
  await h.media.leave();
  join.resolve();
  await connecting;
  assert.ok(h.rooms[0].disconnected >= 1);
  assert.equal(h.media.connected, false);
  await h.media.connect(2, 3);
  assert.equal(h.rooms.length, 2);
  assert.equal(h.media.connected, true);
});

test('a subscribed slide track requests high quality regardless of small pane dimensions', async () => {
  const h = harness();
  await h.media.connect(1, 2);
  const room = h.rooms[0];
  assert.equal(room.options.adaptiveStream, false);
  const quality = [], track = { kind: 'video', detach() {} };
  room.events.TrackSubscribed(track, { source: 'screen', setVideoQuality: q => quality.push(q) });
  assert.deepEqual(quality, ['high']);
  assert.equal(h.tracks.at(-1), track);
  assert.equal(h.phases.at(-1), 'viewing');
  room.events.TrackUnsubscribed(track);
  assert.equal(h.tracks.at(-1), null);
  assert.equal(h.phases.at(-1), 'waiting');
});

test('reconnecting prevents publishing and restores readiness afterwards', async () => {
  const h = harness();
  await h.media.connect(1, 2);
  h.rooms[0].events.Reconnecting();
  assert.equal(h.phases.at(-1), 'reconnecting');
  await assert.rejects(h.media.start());
  h.rooms[0].events.Reconnected();
  assert.equal(h.media.connected, true);
  await h.media.start();
  assert.equal(h.phases.at(-1), 'sharing');
  const [enabled, options] = h.captures.at(-1);
  assert.equal(enabled, true);
  assert.equal(options.resolution.height, 1080);
  assert.equal(options.contentHint, 'detail');
  assert.equal(h.rooms[0].options.publishDefaults.degradationPreference, 'maintain-resolution');
  assert.equal(h.rooms[0].options.publishDefaults.simulcast, false);
});

test('a picker that resolves after leaving cannot keep broadcasting into the old room', async () => {
  const picker = deferred(), h = harness({ picker });
  await h.media.connect(1, 2);
  const sharing = h.media.start();
  await h.media.leave();
  picker.resolve();
  await sharing;
  assert.deepEqual(h.captures.map(args => args[0]), [true, false]);
  assert.equal(h.phases.at(-1), 'idle');
});

test('screen picker rejection leaves the viewer connected for another attempt', async () => {
  const picker = deferred(), h = harness({ picker });
  await h.media.connect(1, 2);
  const sharing = h.media.start();
  picker.reject(new Error('permission denied'));
  await assert.rejects(sharing, /permission denied/);
  assert.equal(h.media.connected, true);
  assert.equal(h.phases.at(-1), 'waiting');
});

test('failed connection cleans up and shows a retryable state', async () => {
  const join = deferred(), h = harness({ join });
  const connecting = h.media.connect(1, 2);
  join.reject(new Error('unreachable media service'));
  await assert.rejects(connecting, /unreachable/);
  assert.equal(h.media.room, null);
  assert.equal(h.media.connected, false);
  assert.equal(h.phases.at(-1), 'failed');
});

test('an old room disconnect cannot clear the current channel connection', async () => {
  const h = harness();
  await h.media.connect(1, 2);
  const old = h.rooms[0];
  await h.media.leave();
  await h.media.connect(1, 3);
  old.events.disconnected();
  assert.equal(h.media.room, h.rooms[1]);
  assert.equal(h.media.connected, true);
});
