/* One SFU connection per page. A generation invalidates pending joins/pickers. */
export class ClassroomMedia {
  constructor({ loadSdk, token, onState, onTrack }) {
    Object.assign(this, { loadSdk, token, onState, onTrack });
    this.generation = 0;
    this.room = null;
    this.connected = false;
    this.track = null;
    this.sharing = false;
    this.publishing = false;
    this.phase = 'idle';
    this.canPublish = false;
  }

  report(phase) { this.phase = phase; this.onState(phase); }

  async leave() {
    this.generation++;
    const room = this.room;
    this.room = null;
    this.connected = false;
    this.canPublish = false;
    this.sharing = false;
    this.publishing = false;
    this.track?.detach();
    this.track = null;
    this.onTrack(null);
    this.report('idle');
    if (room) await room.disconnect();
  }

  async connect(cohortId, channelId, providedConfig = null) {
    if (this.phase === 'connecting' || this.room) return;
    const generation = ++this.generation;
    this.report('connecting');
    let room;
    const current = () => this.generation === generation;
    try {
      const [sdk, config] = await Promise.all([this.loadSdk(), providedConfig || this.token(cohortId, channelId)]);
      if (!current()) return;
      room = new sdk.Room({
        // Layout size must not select a blurry layer for slides.
        adaptiveStream: false, dynacast: true,
        publishDefaults: {
          videoCodec: 'vp8', simulcast: false,
          degradationPreference: 'maintain-resolution',
          screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15 },
        },
      });
      this.room = room;
      room.on(sdk.RoomEvent.TrackSubscribed, (track, publication) => {
        if (!current() || track.kind !== sdk.Track.Kind.Video || publication.source !== sdk.Track.Source.ScreenShare) return;
        publication.setVideoQuality(sdk.VideoQuality.HIGH);
        this.track?.detach();
        this.track = track;
        this.onTrack(track);
        this.report('viewing');
      });
      room.on(sdk.RoomEvent.TrackUnsubscribed, track => {
        track.detach();
        if (current() && this.track === track) {
          this.track = null;
          this.onTrack(null);
          this.report('waiting');
        }
      });
      room.on(sdk.RoomEvent.Reconnecting, () => { if (current()) { this.connected = false; this.report('reconnecting'); } });
      room.on(sdk.RoomEvent.Reconnected, () => { if (current()) { this.connected = true; this.report(this.track ? 'viewing' : 'waiting'); } });
      room.on(sdk.RoomEvent.Disconnected, () => {
        if (current()) {
          void this.leave();
          this.report('disconnected');
        }
      });
      room.on(sdk.RoomEvent.LocalTrackUnpublished, publication => {
        if (current() && publication.source === sdk.Track.Source.ScreenShare) {
          this.sharing = false;
          this.report(this.track ? 'viewing' : 'waiting');
        }
      });
      await room.connect(config.url, config.token);
      if (!current()) { await room.disconnect(); return; }
      this.connected = true;
      this.canPublish = config.can_publish === true;
      this.report(this.track ? 'viewing' : 'waiting');
    } catch (error) {
      if (current()) { await this.leave(); this.report('failed'); throw error; }
      if (room) await room.disconnect();
    }
  }

  async start() {
    if (!this.connected || !this.room) throw new Error('먼저 화면 공유에 연결하세요');
    if (!this.canPublish) throw new Error('이 세션에서는 화면을 공유할 수 없습니다');
    if (this.publishing || this.sharing) return;
    const generation = this.generation, room = this.room;
    this.publishing = true;
    this.report(this.phase);
    try {
      await room.localParticipant.setScreenShareEnabled(true, {
        audio: false, contentHint: 'detail',
        resolution: { width: 1920, height: 1080, frameRate: 15 },
      });
      if (generation !== this.generation) {
        // The screen picker can resolve after a channel change/disconnect.
        await room.localParticipant.setScreenShareEnabled(false);
        return;
      }
      this.sharing = true;
      this.report('sharing');
    } finally {
      if (generation === this.generation) {
        this.publishing = false;
        this.report(this.phase);
      }
    }
  }

  async stop() {
    const generation = this.generation;
    await this.room?.localParticipant.setScreenShareEnabled(false);
    if (generation === this.generation) {
      this.sharing = false;
      this.report(this.track ? 'viewing' : 'waiting');
    }
  }
}
