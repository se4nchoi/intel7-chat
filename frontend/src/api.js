const API_BASE = '/hub/api';

export async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (options.json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.json);
  }
  delete init.json;
  const response = await fetch(`${API_BASE}${path}`, init);
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `Request failed (${response.status})`);
  return data;
}

export function channelSocket(cohortId, channelId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${location.host}/hub/ws/cohorts/${cohortId}/channels/${channelId}`);
}

export function fileDownloadUrl(cohortId, fileId) {
  return `${API_BASE}/cohorts/${cohortId}/files/${fileId}`;
}

export async function uploadFile(cohortId, form) {
  const response = await fetch(`${API_BASE}/cohorts/${cohortId}/files`, {
    method: 'POST', credentials: 'same-origin', body: new FormData(form),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Upload failed (${response.status})`);
  }
}
