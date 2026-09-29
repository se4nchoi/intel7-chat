import { errorMessage, installKoreanValidation } from './korean.js';
import { api, channelSocket, fileDownloadUrl, uploadFile } from './api.js';
import { readRoute, spaceUrl } from './navigation.js';

const $ = id => document.getElementById(id);
const ROLE_LABEL = { admin: '관리자', instructor: '강사', student: '수강생', member: '구성원' };
const FORM_IDS = ['message-form', 'question-form', 'answer-form', 'file-form', 'membership-form', 'channel-form'];
const GROUP_GAP_MS = 5 * 60 * 1000;

let cohortRequest = 0;
const state = {
  account: null, cohorts: [], cohort: null, channel: null, socket: null, mediaRoom: null,
  space: readRoute(location.pathname).space, epoch: 0, channelEpoch: 0, questionEpoch: 0, mediaEpoch: 0,
  channels: new Map(), lastMessage: null, lastSeenId: 0, reconnectTimer: null, reconnectNow: null,
  questions: [], question: null, filter: 'all', search: '', boardView: 'home', fileCount: null,
};

/* ---------- small helpers ---------- */
let statusTimer;
function status(message, error = false) {
  clearTimeout(statusTimer);
  $('status').textContent = error ? errorMessage(message) : message;
  $('status').className = `toast ${error ? 'error' : ''}`;
  if (message && !error) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}
const isManager = () => ['admin', 'instructor'].includes(state.cohort?.role);
const roleClass = role => (role === 'instructor' || role === 'admin') ? role : '';
function hue(text) { let h = 0; for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
function initials(name) { const trimmed = String(name || '?').trim(); return /[가-힣]/.test(trimmed[0]) ? trimmed.slice(0, 1) : trimmed.slice(0, 2).toUpperCase(); }
function avatar(name, key, small = false) {
  const node = el('span', { class: `avatar${small ? ' sm' : ''}`, 'aria-hidden': 'true', text: initials(name) });
  node.style.setProperty('--hue', hue(key || name));
  return node;
}
function roleTag(role) { return role && role !== 'student' ? el('span', { class: `tag ${roleClass(role)}`, text: ROLE_LABEL[role] || role }) : null; }
const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const shortFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' });
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function daysAgo(value) { return Math.round((startOfDay(new Date()) - startOfDay(new Date(value))) / 86400000); }
function stamp(value) {
  if (!value) return '';
  const days = daysAgo(value), time = timeFmt.format(new Date(value));
  return days === 0 ? `오늘 ${time}` : days === 1 ? `어제 ${time}` : `${shortFmt.format(new Date(value))} ${time}`;
}
function feedTime(value) { const days = daysAgo(value); return days === 0 ? timeFmt.format(new Date(value)) : shortFmt.format(new Date(value)); }
function formValues(form) { return Object.fromEntries(new FormData(form)); }
function closeChat() {
  clearTimeout(state.reconnectTimer); state.reconnectTimer = null; state.reconnectNow = null;
  const socket = state.socket; state.socket = null; socket?.close();
}
function closeNav() { $('hub-app').classList.remove('nav-open'); }

/* ---------- theme ---------- */
function applyTheme(theme) { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }
try { applyTheme(localStorage.getItem('madi-theme') ?? localStorage.getItem('bamboo-theme')); } catch { /* storage unavailable */ }
$('theme-btn').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('madi-theme', next); localStorage.removeItem('bamboo-theme'); } catch { /* storage unavailable */ }
});

/* ---------- shell ---------- */
function showAccount() {
  $('login-card').classList.toggle('hidden', !!state.account);
  $('hub-app').classList.toggle('hidden', !state.account);
  const name = state.account?.display_name || state.account?.username || '';
  $('account-name').textContent = name;
  $('account-label').textContent = state.account ? `@${state.account.username}` : '';
  $('user-avatar').textContent = initials(name);
  $('user-avatar').style.setProperty('--hue', hue(state.account?.username || ''));
  $('admin-card').classList.toggle('hidden', !state.account?.is_admin);
}
function renderRail() {
  $('cohort-rail').replaceChildren(...state.cohorts.map(cohort => el('button', {
    class: `rail-item${cohort.archived ? ' archived' : ''}`, title: cohort.name, 'aria-label': cohort.name,
    'aria-current': String(cohort.id === state.cohort?.id), text: initials(cohort.name),
    onclick: () => { closeNav(); selectCohort(cohort.id).catch(error => status(error.message, true)); },
  })));
}
function updateControls() {
  const writable = !!state.cohort && !state.cohort.archived;
  for (const id of FORM_IDS) {
    const enabled = writable && (id !== 'message-form' || !!state.channel) && (id !== 'answer-form' || !!state.question);
    for (const control of $(id).elements) control.disabled = !enabled;
  }
  $('new-post-btn').disabled = !writable;
  $('media-connect').disabled = !writable || !state.channel;
  $('media-start').disabled = !writable || !state.mediaRoom;
}
function resetContent() {
  state.epoch++; state.channelEpoch++; state.questionEpoch++;
  closeChat(); void leaveMedia().catch(error => status(error.message, true));
  state.channel = null; state.question = null; state.questions = []; state.lastMessage = null; state.lastSeenId = 0; state.fileCount = null;
  for (const id of ['channel-list', 'messages', 'question-list', 'instructor-answers', 'student-answers', 'file-list', 'member-list', 'board-stats']) $(id).replaceChildren();
  $('channel-heading').textContent = '채널을 선택하세요';
  $('message-input').placeholder = '메시지 보내기';
  updateControls();
}
function showSpace() {
  const cohort = state.cohort, chat = state.space === 'chat';
  $('chat-space').classList.toggle('hidden', !cohort || !chat);
  $('board-space').classList.toggle('hidden', !cohort || chat);
  $('chat-side').classList.toggle('hidden', !cohort || !chat);
  $('board-side').classList.toggle('hidden', !cohort || chat);
  $('empty-space').classList.toggle('hidden', !!cohort);
  $('hub-app').classList.toggle('board-mode', !!cohort && !chat);
  $('cohort-name').textContent = cohort?.name || '마디';
  $('role-label').textContent = cohort ? `${ROLE_LABEL[cohort.role] || '구성원'}${cohort.archived ? ' · 종료됨' : ''}` : '';
  $('role-label').className = `role-chip ${roleClass(cohort?.role)}`;
  const manage = !!cohort && isManager();
  $('manage-card').classList.toggle('hidden', !manage);
  $('manage-btn').classList.toggle('hidden', !manage && !state.account?.is_admin);
  $('add-channel-btn').classList.toggle('hidden', !manage || !!cohort?.archived);
  $('media-start').classList.toggle('hidden', !manage);
  const instructorOption = $('membership-form').elements.role.querySelector('[value="instructor"]');
  instructorOption.disabled = instructorOption.hidden = !state.account?.is_admin;
  if (!state.account?.is_admin) $('membership-form').elements.role.value = 'student';
  for (const space of ['chat', 'board']) {
    const link = $(`${space}-link`);
    link.href = cohort ? spaceUrl(cohort.slug, space) : '/hub';
    if (space === state.space) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    $(`${space}-cohort`).textContent = cohort?.name || '';
  }
  document.title = `마디 · ${chat ? '채팅' : 'Q&A 게시판'}${cohort ? ` · ${cohort.name}` : ''}`;
  renderRail();
  updateControls();
}

/* ---------- boot / cohorts / spaces ---------- */
async function boot() {
  try { state.account = await api('/me'); }
  catch { showAccount(); return; }
  showAccount();
  try { await loadCohorts(); } catch (error) { status(error.message, true); }
}
async function loadCohorts(preferredId) {
  const request = ++cohortRequest, account = state.account;
  const cohorts = await api('/cohorts');
  if (request !== cohortRequest || state.account !== account) return;
  state.cohorts = cohorts;
  const route = readRoute(location.pathname);
  state.space = route.space;
  const chosen = preferredId ? state.cohorts.find(c => c.id === Number(preferredId)) : route.slug ? state.cohorts.find(c => c.slug === route.slug) : state.cohorts[0];
  if (!chosen) {
    state.cohort = null; resetContent(); showSpace();
    status(route.slug ? '이 수강반에 접근할 수 없습니다. 참여 중인 수강반을 선택하세요.' : '아직 배정된 수강반이 없습니다. 강사에게 참여 권한을 요청하세요.');
    return;
  }
  await selectCohort(chosen.id, 'replace');
}
async function selectCohort(id, historyMode = 'push') {
  const next = state.cohorts.find(c => c.id === Number(id));
  if (!next) return;
  if (state.cohort?.id !== next.id) {
    for (const formId of FORM_IDS) $(formId).reset();
    state.filter = 'all'; state.search = ''; $('post-search').value = ''; syncFilterButtons();
  }
  state.cohort = next;
  const url = spaceUrl(next.slug, state.space) + (historyMode === 'replace' ? location.hash : '');
  if (historyMode === 'replace') history.replaceState(null, '', url);
  else if (location.pathname !== url) history.pushState(null, '', url);
  await loadSpace();
}
async function loadSpace() {
  resetContent(); showSpace();
  const epoch = state.epoch;
  try {
    if (state.space === 'chat') await Promise.all([loadChannels(), loadMembers()]);
    else await loadBoard();
    if (epoch === state.epoch && state.cohort.archived) status('종료된 수강반입니다. 기존 내용만 열람할 수 있습니다.');
  } catch (error) { if (epoch === state.epoch) status(error.message, true); }
}
for (const space of ['chat', 'board']) {
  $(`${space}-link`).addEventListener('click', async event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!state.cohort || state.space === space) return;
    state.space = space; history.pushState(null, '', spaceUrl(state.cohort.slug, space));
    await loadSpace(); closeNav();
    $(space === 'chat' ? 'channel-heading' : 'board-heading').focus();
  });
}
window.addEventListener('popstate', () => { if (state.account) loadCohorts().catch(error => status(error.message, true)); });
for (const button of document.querySelectorAll('.menu-btn')) button.addEventListener('click', () => $('hub-app').classList.add('nav-open'));
$('scrim').addEventListener('click', closeNav);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeNav(); $('hub-app').classList.remove('members-open'); } });

/* ---------- chat ---------- */
async function loadChannels() {
  const epoch = state.epoch, cohort = state.cohort;
  const channels = await api(`/cohorts/${cohort.id}/channels`);
  if (epoch !== state.epoch) return;
  const list = $('channel-list'); list.replaceChildren();
  for (const channel of channels) {
    list.append(el('button', {
      dataset: { id: channel.id }, 'aria-pressed': 'false',
      onclick: () => { closeNav(); selectChannel(channel).catch(error => status(error.message, true)); },
    }, el('span', { class: 'hash', 'aria-hidden': 'true', text: '#' }), el('span', { text: channel.name })));
  }
  if (channels.length) await selectChannel(channels.find(c => c.id === state.channels.get(cohort.id)) || channels[0]);
  else {
    list.append(el('p', { class: 'muted', text: '아직 채널이 없습니다.' }));
    $('messages').append(el('p', { class: 'muted', text: cohort.archived ? '종료된 수강반이라 채널을 만들 수 없습니다.' : isManager() ? '채널 목록 옆의 + 버튼으로 첫 채널을 만드세요.' : '강사에게 채널 개설을 요청하세요.' }));
    updateControls();
  }
}
async function loadMembers() {
  const epoch = state.epoch, cohort = state.cohort;
  let members;
  try { members = await api(`/cohorts/${cohort.id}/members`); } catch { return; }
  if (epoch !== state.epoch) return;
  const groups = [['instructor', '강사'], ['student', '수강생']];
  const nodes = [];
  for (const [role, label] of groups) {
    const people = members.filter(m => m.role === role);
    if (!people.length) continue;
    nodes.push(el('h3', { text: `${label} — ${people.length}` }));
    for (const person of people) nodes.push(el('div', { class: `member ${roleClass(role)}`, title: `@${person.username}` }, avatar(person.display_name, person.username, true), el('span', { text: person.display_name })));
  }
  if (!nodes.length) nodes.push(el('p', { class: 'muted', text: '구성원이 없습니다.' }));
  $('member-list').replaceChildren(...nodes);
}
async function selectChannel(channel) {
  const epoch = state.epoch, channelEpoch = ++state.channelEpoch, cohort = state.cohort;
  closeChat(); await leaveMedia();
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  state.channel = channel; state.channels.set(cohort.id, channel.id); state.lastMessage = null; state.lastSeenId = 0;
  $('channel-heading').textContent = `# ${channel.name}`;
  $('message-input').placeholder = `#${channel.name}에 메시지 보내기`;
  $('messages').replaceChildren(el('div', { class: 'channel-intro' },
    el('div', { class: 'hash-big', 'aria-hidden': 'true', text: '#' }),
    el('h3', { text: `#${channel.name}에 오신 것을 환영합니다` }),
    el('p', { class: 'muted', text: `${cohort.name}의 #${channel.name} 채널입니다. 최근 메시지 100개까지 표시됩니다.` })));
  updateControls();
  for (const button of $('channel-list').querySelectorAll('button')) {
    const active = button.dataset.id === String(channel.id);
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  connectChat(cohort, channel);
}
const REVOKED_MESSAGE = '로그인이 만료되었거나 이 수강반에 접근할 수 없어 채팅 연결이 종료되었습니다. 다시 로그인하세요.';
// Open the socket first and hold live messages while fetching history (or,
// after a drop, everything since the last message seen), so nothing posted in
// between is lost or shown out of order. Drops reconnect with backoff.
function connectChat(cohort, channel, retry = 0) {
  const epoch = state.epoch, channelEpoch = state.channelEpoch;
  const current = () => epoch === state.epoch && channelEpoch === state.channelEpoch;
  const socket = channelSocket(cohort.id, channel.id); state.socket = socket;
  let held = [], opened = false;
  const receive = message => { state.lastSeenId = Math.max(state.lastSeenId, message.id); appendMessage(message); };
  socket.onmessage = event => {
    if (state.socket !== socket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === 'message') { if (held) held.push(payload.message); else receive(payload.message); }
  };
  socket.onopen = async () => {
    opened = true;
    const after = state.lastSeenId ? `?after=${state.lastSeenId}` : '';
    try {
      const missed = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages${after}`);
      if (state.socket !== socket) return;
      missed.forEach(receive); held.forEach(receive); held = null;
      if (retry) status('채팅에 다시 연결되었습니다.');
    } catch (error) {
      if (state.socket === socket) { status(error.message, true); socket.close(); }
    }
  };
  socket.onclose = async event => {
    if (state.socket !== socket) return;
    state.socket = null;
    // 1008: the server revoked this session or cohort access (logout elsewhere, expiry, removal).
    if (event.code === 1008) { status(REVOKED_MESSAGE, true); return; }
    // A handshake refused before opening looks like a network error; check the session.
    if (!opened) {
      try { await api('/me'); } catch (error) {
        // 401: the session is gone. Anything else (server down, no network) is worth retrying.
        if (error.status === 401) { if (current()) status(REVOKED_MESSAGE, true); return; }
      }
    }
    if (!current()) return;
    const next = opened ? 1 : retry + 1;
    const delay = Math.min(30000, 500 * 2 ** next) * (0.75 + Math.random() / 2);
    status('채팅 연결이 끊겼습니다. 다시 연결하는 중…', true);
    const reconnect = () => {
      clearTimeout(state.reconnectTimer); state.reconnectTimer = null; state.reconnectNow = null;
      if (current()) connectChat(cohort, channel, next);
    };
    state.reconnectTimer = setTimeout(reconnect, delay); state.reconnectNow = reconnect;
  };
}
// Skip the wait when the network or the tab comes back.
addEventListener('online', () => state.reconnectNow?.());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') state.reconnectNow?.(); });
function appendMessage(message) {
  const box = $('messages');
  if (box.querySelector(`[data-message-id="${message.id}"]`)) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const when = new Date(message.created_at), prev = state.lastMessage;
  if (!prev || startOfDay(prev.created_at).getTime() !== startOfDay(when).getTime()) {
    box.append(el('div', { class: 'day-divider', role: 'separator', text: dayFmt.format(when) }));
  }
  const grouped = prev && prev.username === message.username && when - new Date(prev.created_at) < GROUP_GAP_MS
    && box.lastElementChild?.classList.contains('msg');
  const name = message.display_name || message.username;
  const time = el('time', { datetime: message.created_at, text: stamp(message.created_at), title: when.toLocaleString('ko-KR') });
  const row = grouped
    ? el('div', { class: 'msg', dataset: { messageId: message.id } },
        el('span', { class: 'hover-time', 'aria-hidden': 'true', text: timeFmt.format(when) }),
        el('div', { class: 'msg-body', text: message.body }))
    : el('div', { class: 'msg head', dataset: { messageId: message.id } },
        avatar(name, message.username),
        el('div', { class: 'msg-head' }, el('strong', { class: roleClass(message.role), text: name, title: `@${message.username}` }), roleTag(message.role), time),
        el('div', { class: 'msg-body', text: message.body }));
  box.append(row);
  state.lastMessage = message;
  if (nearBottom || message.username === state.account?.username) box.scrollTop = box.scrollHeight;
}
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('message-input').addEventListener('input', event => {
  const input = event.target; input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
$('members-toggle').addEventListener('click', event => {
  const app = $('hub-app'), narrow = matchMedia('(max-width: 1100px)').matches;
  if (narrow) { app.classList.toggle('members-open'); event.currentTarget.setAttribute('aria-pressed', String(app.classList.contains('members-open'))); }
  else { const hidden = $('member-list').classList.toggle('hidden'); event.currentTarget.setAttribute('aria-pressed', String(!hidden)); }
});
$('stage-toggle').addEventListener('click', event => {
  const hidden = $('stage').classList.toggle('hidden');
  event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  $('messages').scrollTop = $('messages').scrollHeight;
});

/* ---------- board ---------- */
async function loadBoard() {
  const postId = Number((location.hash.match(/^#post-(\d+)$/) || [])[1]);
  await Promise.all([loadQuestions(), loadFileCount()]);
  const target = postId && state.questions.find(q => q.id === postId);
  if (target) await selectQuestion(target, false);
  else showBoardView(state.boardView === 'files' ? 'files' : 'home');
}
async function loadQuestions() {
  const epoch = state.epoch, cohort = state.cohort;
  const questions = await api(`/cohorts/${cohort.id}/questions`);
  if (epoch !== state.epoch) return;
  state.questions = questions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (state.question) state.question = questions.find(q => q.id === state.question.id) || state.question;
  renderFeed(); renderStats();
}
async function loadFileCount() {
  if (state.boardView === 'files') return loadFiles();
  const epoch = state.epoch;
  try { const files = await api(`/cohorts/${state.cohort.id}/files`); if (epoch === state.epoch) { state.fileCount = files.length; renderStats(); } } catch { /* stats only */ }
}
const FILTERS = {
  all: () => true,
  unanswered: q => Number(q.answer_count) === 0,
  'no-instructor': q => !q.instructor_answered,
  mine: q => q.username === state.account?.username,
};
function feedGroup(value) {
  const days = daysAgo(value);
  return days <= 0 ? '오늘' : days === 1 ? '어제' : days < 7 ? '이번 주' : days < 14 ? '지난주' : '이전';
}
function renderFeed() {
  const term = state.search.trim().toLowerCase();
  const items = state.questions.filter(FILTERS[state.filter]).filter(q => !term || `${q.title}\n${q.body}\n${q.display_name || ''}`.toLowerCase().includes(term));
  const list = $('question-list'), nodes = [];
  let group = null;
  for (const q of items) {
    const g = feedGroup(q.created_at);
    if (g !== group) { group = g; nodes.push(el('li', { class: 'feed-group', role: 'presentation', text: g })); }
    const answers = Number(q.answer_count);
    const button = el('button', { class: state.question?.id === q.id ? 'active' : '', 'aria-current': state.question?.id === q.id ? 'true' : null, onclick: () => { closeNav(); selectQuestion(q).catch(error => status(error.message, true)); } },
      el('span', { class: 'feed-title' }, el('span', { text: q.title }), el('time', { datetime: q.created_at, text: feedTime(q.created_at) })),
      el('span', { class: 'feed-snippet', text: q.body }),
      el('span', { class: 'feed-badges' },
        q.instructor_answered ? el('span', { class: 'badge-i', title: '강사 답변 있음', text: 'i' }) : null,
        answers > 0 ? el('span', { class: 'badge-s', title: '답변 있음', text: 's' }) : null,
        q.endorsed ? el('span', { class: 'endorsed-mark', text: '✓ 인정됨' }) : null,
        answers === 0 ? el('span', { class: 'tag danger', text: '미답변' }) : el('span', { text: `답변 ${answers}` }),
        el('span', { text: `· ${q.display_name || q.username}` })));
    nodes.push(el('li', { class: `feed-item${answers === 0 ? ' unanswered' : ''}` }, button));
  }
  if (!nodes.length) nodes.push(el('li', { class: 'feed-empty', text: state.questions.length ? '조건에 맞는 질문이 없습니다.' : state.cohort?.archived ? '이 수강반에는 질문이 없습니다.' : '아직 질문이 없습니다. 첫 질문을 올려 보세요.' }));
  list.replaceChildren(...nodes);
}
function renderStats() {
  const qs = state.questions;
  const stat = (value, label, warn = false) => el('div', { class: `stat${warn && value ? ' warn' : ''}` }, el('strong', { text: String(value ?? '–') }), el('span', { text: label }));
  $('board-stats').replaceChildren(
    stat(qs.length, '전체 질문'),
    stat(qs.filter(FILTERS.unanswered).length, '미답변', true),
    stat(qs.filter(q => q.instructor_answered).length, '강사 답변'),
    stat(state.fileCount, '공유 자료'));
}
function syncFilterButtons() {
  for (const button of document.querySelectorAll('.filters button')) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
}
for (const button of document.querySelectorAll('.filters button')) {
  button.addEventListener('click', () => { state.filter = button.dataset.filter; syncFilterButtons(); renderFeed(); });
}
$('post-search').addEventListener('input', event => { state.search = event.target.value; renderFeed(); });
function showBoardView(view) {
  state.boardView = view;
  for (const [name, id] of [['home', 'board-home'], ['post', 'post-view'], ['compose', 'compose-view'], ['files', 'files-view']]) $(id).classList.toggle('hidden', name !== view);
  $('files-link').setAttribute('aria-current', String(view === 'files'));
  if (view !== 'post') {
    state.question = null; state.questionEpoch++;
    if (location.hash) history.replaceState(null, '', location.pathname);
    renderFeed(); updateControls();
  }
  $('board-heading').textContent = { home: 'Q&A 게시판', post: 'Q&A 게시판', compose: '새 질문', files: '자료실' }[view];
  $('board-space').querySelector('.board-body').scrollTop = 0;
}
async function selectQuestion(question, updateUrl = true) {
  const epoch = state.epoch, questionEpoch = ++state.questionEpoch, cohort = state.cohort;
  state.question = question;
  showBoardView('post');
  if (updateUrl) history.replaceState(null, '', `${location.pathname}#post-${question.id}`);
  $('board-heading').textContent = question.title;
  $('post-title').textContent = question.title;
  $('post-meta').replaceChildren(...[avatar(question.display_name || question.username, question.username, true),
    el('strong', { text: question.display_name || question.username }), roleTag(question.role),
    el('span', { text: `· ${stamp(question.created_at)}` }), el('span', { text: `· 질문 #${question.id}` })].filter(Boolean));
  $('post-body').textContent = question.body;
  $('instructor-answers').replaceChildren(); $('student-answers').replaceChildren();
  renderFeed(); updateControls();
  const answers = await api(`/cohorts/${cohort.id}/questions/${question.id}/answers`);
  if (epoch !== state.epoch || questionEpoch !== state.questionEpoch) return;
  renderAnswers(answers);
}
function renderAnswers(answers) {
  const byInstructor = a => a.role === 'instructor' || a.role === 'admin';
  const canEndorse = isManager() && !state.cohort.archived;
  const item = answer => el('li', { class: answer.endorsed ? 'endorsed' : '' },
    el('div', { class: 'answer-meta' },
      avatar(answer.display_name || answer.username, answer.username, true),
      el('strong', { text: answer.display_name || answer.username }), roleTag(answer.role),
      el('span', { text: stamp(answer.created_at) }),
      answer.endorsed ? el('span', { class: 'endorsed-mark', text: '✓ 강사 인정' }) : null,
      canEndorse && !byInstructor(answer) ? el('button', { class: 'endorse-btn', text: answer.endorsed ? '인정 취소' : '👍 좋은 답변', onclick: event => endorse(answer, event.currentTarget) }) : null),
    el('div', { class: 'answer-body', text: answer.body }));
  const fill = (id, list, empty) => $(id).replaceChildren(...(list.length ? list.map(item) : [el('li', { class: 'empty-answer', text: empty })]));
  fill('instructor-answers', answers.filter(byInstructor), '아직 강사 답변이 없습니다.');
  fill('student-answers', answers.filter(a => !byInstructor(a)), '아직 수강생 답변이 없습니다. 아는 내용이 있다면 먼저 답해 보세요.');
}
async function endorse(answer, button) {
  const epoch = state.epoch, question = state.question;
  button.disabled = true;
  try {
    await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers/${answer.id}/endorse`, { method: 'POST', json: { endorsed: !answer.endorsed } });
    if (epoch !== state.epoch) return;
    await loadQuestions();
    if (epoch === state.epoch && state.question?.id === question.id) await selectQuestion(state.question, false);
  } catch (error) { status(error.message, true); button.disabled = false; }
}
async function loadFiles() {
  const epoch = state.epoch, cohort = state.cohort;
  const files = await api(`/cohorts/${cohort.id}/files`);
  if (epoch !== state.epoch) return;
  state.fileCount = files.length; renderStats();
  const list = $('file-list');
  if (!files.length) { list.replaceChildren(el('li', { class: 'muted', text: '아직 공유된 자료가 없습니다.' })); return; }
  list.replaceChildren(...files.map(file => {
    const ext = (file.original_name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const size = file.size_bytes >= 1048576 ? `${(file.size_bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(file.size_bytes / 1024)} KB`;
    return el('li', {}, el('span', { class: 'file-icon', 'aria-hidden': 'true', text: ext }),
      el('div', { class: 'file-info' }, el('a', { href: fileDownloadUrl(cohort.id, file.id), text: file.original_name }),
        el('small', { text: `@${file.username} · ${size} · ${stamp(file.created_at)}` })));
  }));
}
$('new-post-btn').addEventListener('click', () => { closeNav(); showBoardView('compose'); $('question-form').elements.title.focus(); });
$('compose-cancel').addEventListener('click', () => showBoardView('home'));
$('files-link').addEventListener('click', () => { closeNav(); showBoardView('files'); loadFiles().catch(error => status(error.message, true)); });

/* ---------- forms ---------- */
function handleForm(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit], button:not([type])');
    if (button) button.disabled = true;
    const epoch = state.epoch;
    try { await action(form); if (epoch === state.epoch || id === 'login-form') form.reset(); }
    catch (error) { status(error.message, true); }
    finally { if (button) button.disabled = false; updateControls(); }
  });
}

handleForm('login-form', async form => {
  await api('/login', { method: 'POST', json: formValues(form) });
  state.account = await api('/me');
  status('');
  showAccount();
  await loadCohorts();
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch (error) { status(error.message, true); return; }
  state.cohort = null; resetContent();
  state.account = null; state.cohorts = [];
  showAccount(); showSpace();
  status('로그아웃되었습니다.');
});

handleForm('message-form', async () => {
  if (!state.cohort || !state.channel) throw new Error('먼저 채널을 선택하세요');
  const epoch = state.epoch, channelEpoch = state.channelEpoch;
  const body = $('message-input').value.trim();
  if (!body) return;
  const message = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages`, { method: 'POST', json: { body } });
  $('message-input').style.height = '';
  if (epoch === state.epoch && channelEpoch === state.channelEpoch) appendMessage(message);
});

handleForm('question-form', async form => {
  const epoch = state.epoch;
  const { id } = await api(`/cohorts/${state.cohort.id}/questions`, { method: 'POST', json: formValues(form) });
  if (epoch !== state.epoch) return;
  await loadQuestions();
  const created = state.questions.find(q => q.id === id);
  if (epoch === state.epoch && created) await selectQuestion(created);
  status('질문을 등록했습니다.');
});

handleForm('answer-form', async form => {
  if (!state.question) throw new Error('질문을 선택하세요');
  const epoch = state.epoch, question = state.question;
  await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers`, { method: 'POST', json: formValues(form) });
  if (epoch !== state.epoch) return;
  await loadQuestions();
  if (epoch === state.epoch && state.question?.id === question.id) await selectQuestion(state.question, false);
});

handleForm('file-form', async form => {
  const epoch = state.epoch;
  await uploadFile(state.cohort.id, form);
  if (epoch === state.epoch) await loadFiles();
  status('파일을 올렸습니다.');
});

handleForm('account-form', async form => {
  await api('/accounts', { method: 'POST', json: formValues(form) });
  status('계정을 만들었습니다. 수강반에 구성원으로 추가해 주세요.');
});

handleForm('cohort-form', async form => {
  const cohort = await api('/cohorts', { method: 'POST', json: formValues(form) });
  await loadCohorts(cohort.id);
  status('수강반을 만들었습니다. 구성원과 채널을 추가해 주세요.');
});

handleForm('membership-form', async form => {
  await api(`/cohorts/${state.cohort.id}/memberships`, { method: 'POST', json: formValues(form) });
  if (state.space === 'chat') await loadMembers();
  status('구성원 정보를 저장했습니다.');
});

handleForm('channel-form', async form => {
  await api(`/cohorts/${state.cohort.id}/channels`, { method: 'POST', json: formValues(form) });
  if (state.space === 'chat') await loadChannels();
  $('management').close();
  status('채널을 만들었습니다.');
});

$('manage-btn').addEventListener('click', () => $('management').showModal());
$('add-channel-btn').addEventListener('click', () => { $('management').showModal(); $('channel-form').elements.slug.focus(); });
$('management-close').addEventListener('click', () => $('management').close());

/* ---------- screen share (LiveKit SFU) ---------- */
async function leaveMedia() {
  state.mediaEpoch++;
  const room = state.mediaRoom;
  state.mediaRoom = null;
  $('media-video').srcObject = null;
  $('media-video').classList.remove('connected');
  $('media-status').textContent = '연결하면 공유 화면을 볼 수 있습니다.';
  $('media-stop').classList.add('hidden');
  $('media-connect').textContent = '연결하기';
  updateControls();
  if (room) await room.disconnect();
}

$('media-connect').addEventListener('click', async () => {
  try {
    if (state.mediaRoom) { await leaveMedia(); return; }
    if (!state.cohort || !state.channel) throw new Error('채널을 선택하세요');
    const epoch = state.epoch, mediaEpoch = state.mediaEpoch, cohort = state.cohort, channel = state.channel;
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const config = await api(`/cohorts/${cohort.id}/channels/${channel.id}/media-token`, { method: 'POST' });
    if (epoch !== state.epoch || mediaEpoch !== state.mediaEpoch) return;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, track => {
      if (state.mediaRoom === room && track.kind === Track.Kind.Video) { track.attach($('media-video')); $('media-video').classList.add('connected'); }
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach());
    room.on(RoomEvent.Disconnected, () => { if (state.mediaRoom === room) { state.mediaRoom = null; $('media-status').textContent = '화면 공유 연결이 끊겼습니다.'; $('media-connect').textContent = '연결하기'; updateControls(); } });
    state.mediaRoom = room;
    try { await room.connect(config.url, config.token); } catch (error) { if (state.mediaRoom === room) await leaveMedia(); else await room.disconnect(); throw error; }
    if (epoch !== state.epoch || mediaEpoch !== state.mediaEpoch) { await room.disconnect(); return; }
    $('media-status').textContent = '연결되었습니다. 공유 화면을 기다리고 있습니다.';
    $('media-connect').textContent = '연결 끊기';
    updateControls();
  } catch (error) { status(error.message, true); }
});

$('media-start').addEventListener('click', async () => {
  try {
    if (!state.mediaRoom) throw new Error('먼저 화면 공유에 연결하세요');
    await state.mediaRoom.localParticipant.setScreenShareEnabled(true, { audio: false });
    $('media-status').textContent = '이 채널에 화면을 공유하고 있습니다.';
    $('media-stop').classList.remove('hidden');
  } catch (error) { status(error.message, true); }
});

$('media-stop').addEventListener('click', async () => {
  try {
    await state.mediaRoom?.localParticipant.setScreenShareEnabled(false);
    $('media-stop').classList.add('hidden');
    $('media-status').textContent = '화면 공유를 중지했습니다. 다른 사람의 공유 화면은 계속 볼 수 있습니다.';
  } catch (error) { status(error.message, true); }
});

if (matchMedia('(max-width: 1100px)').matches) $('members-toggle').setAttribute('aria-pressed', 'false');
installKoreanValidation();
boot();
