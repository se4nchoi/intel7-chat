import { errorMessage } from './korean.js';

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
  if (response.status === 401 && path !== '/login' && typeof window !== 'undefined') window.dispatchEvent(new Event('madi:unauthorized'));
  if (!response.ok) throw Object.assign(new Error(errorMessage(data?.detail, response.status)), { status: response.status });
  return data;
}

export function cohortSocket(cohortId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${location.host}/hub/ws/cohorts/${cohortId}`);
}

export function fileDownloadUrl(cohortId, fileId) {
  return `${API_BASE}/cohorts/${cohortId}/files/${fileId}`;
}

export async function uploadFile(cohortId, form) {
  const response = await fetch(`${API_BASE}/cohorts/${cohortId}/files`, {
    method: 'POST', credentials: 'same-origin', body: form instanceof FormData ? form : new FormData(form),
  });
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('madi:unauthorized'));
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(errorMessage(data?.detail, response.status));
  }
  return response.json();
}
