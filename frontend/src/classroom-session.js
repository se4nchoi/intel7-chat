/* Temporary routing only: cohort identity and content never depend on a lab IP. */
export class ClassroomSession {
  constructor({ api, onLost, onUpdate = () => {}, onChanged = async () => {}, interval = 15000 }) {
    Object.assign(this, { api, onLost, onUpdate, onChanged, interval });
    this.generation = 0;
    this.active = null;
    this.timer = null;
  }

  request(path, options = {}) {
    return this.api(path, { ...options, signal: AbortSignal.timeout(8000) });
  }

  async release(active) {
    if (active?.requestToken) {
      try { await this.request(`${active.path}/media-session/${active.id}/requests`, {
        method: 'DELETE', json: { request_token: active.requestToken },
      }); } catch { /* instructor may already have revoked it */ }
    }
    if (active?.control) await this.request(`${active.path}/media-session/${active.id}`, {
      method: 'DELETE', json: { control_token: active.control },
    });
  }

  async leave() {
    this.generation++;
    clearInterval(this.timer); this.timer = null;
    const active = this.active; this.active = null;
    this.onUpdate({ session: null, requests: [] });
    // A lost network leaves a bounded lease; it must not block local disconnect.
    try { await this.release(active); } catch { /* expires without heartbeats */ }
  }

  async join(cohort, channel, classroomId) {
    const generation = this.generation;
    const path = `/cohorts/${cohort}/channels/${channel}`;
    const current = () => generation === this.generation;
    const mode = await this.request(`${path}/media-session`);
    if (!current()) throw new Error('Media join cancelled');
    let active = null;
    try {
      if (mode.distributed && classroomId) {
        const result = await this.request(`${path}/media-session`, { method: 'POST', json: { classroom_id: classroomId } });
        active = { path, id: result.session.id, control: result.control_token, cohort, channel };
        if (!current()) throw new Error('Media join cancelled');
        this.active = active;
      }
      const config = await this.request(`${path}/media-token`, { method: 'POST', json: { control_token: active?.control || '' } });
      if (!current()) throw new Error('Media join cancelled');
      this.active = active || (config.session ? { path, id: config.session.id, cohort, channel } : null);
      if (this.active) {
        this.active.revision = config.session.revision || 0;
        this.onUpdate({ session: config.session, requests: mode.requests || [] });
        let busy = false;
        this.timer = setInterval(async () => {
          if (busy || !current()) return;
          busy = true;
          try {
            await this.check();
          } catch {
            if (current()) this.onLost();
          } finally { busy = false; }
        }, this.interval);
      }
      return config;
    } catch (error) {
      if (this.active === active) this.active = null;
      try { await this.release(active); } catch { /* bounded lease */ }
      throw error;
    }
  }

  async token() {
    const active = this.active;
    if (!active) throw new Error('Classroom session ended');
    return this.request(`${active.path}/media-token`, { method: 'POST',
      json: { control_token: active.control || '', request_token: active.requestToken || '' },
    });
  }

  async requestPresentation() {
    const active = this.active, generation = this.generation;
    if (!active) throw new Error('먼저 화면 공유에 연결하세요');
    const result = await this.request(`${active.path}/media-session/${active.id}/requests`, { method: 'POST' });
    if (this.active !== active || this.generation !== generation) {
      await this.release({ ...active, control: null, requestToken: result.request_token });
      return;
    }
    active.requestToken = result.request_token;
    active.requestId = result.request.id;
    await this.check();
  }

  async cancelPresentation() {
    const active = this.active;
    if (!active?.requestToken) return;
    await this.request(`${active.path}/media-session/${active.id}/requests`, {
      method: 'DELETE', json: { request_token: active.requestToken },
    });
    active.requestToken = null;
    await this.check();
  }

  async decidePresentation(id, action) {
    const active = this.active;
    if (!active?.control) throw new Error('공유 세션을 시작한 강사 탭에서 관리하세요');
    await this.request(`${active.path}/media-session/${active.id}/requests/${id}`, {
      method: 'POST', json: { action, control_token: active.control },
    });
    await this.check();
  }

  async check() {
    if (this.checking) return this.checking;
    this.checking = this.refresh();
    try { await this.checking; } finally { this.checking = null; }
  }

  async refresh() {
    const active = this.active, generation = this.generation;
    if (!active) return;
    const current = () => this.active === active && generation === this.generation;
    if (active.control) await this.request(`${active.path}/media-session/${active.id}/heartbeat`, {
      method: 'POST', json: { control_token: active.control },
    });
    const result = await this.request(`${active.path}/media-session`);
    if (!current()) return;
    if (result.session?.id !== active.id) throw new Error('Classroom session ended or changed');
    this.onUpdate(result);
    const revision = result.session.revision || 0;
    if (revision !== active.revision) {
      active.revision = revision;
      await this.onChanged(active);
    }
  }
}
