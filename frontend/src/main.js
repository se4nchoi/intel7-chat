import { errorMessage, installKoreanValidation } from './korean.js';
import { api, cohortSocket, fileDownloadUrl, uploadFile } from './api.js';
import { readRoute, spaceUrl } from './navigation.js';
import { renderRich } from './format.js';
import { DraftStore } from './drafts.js';
import { parseRoster, credentialsCsv, rosterPreviewSummary } from './roster.js';
import { notificationUrl, readAnswerTarget } from './notification-links.js';
import { plainExcerpt } from './excerpt.js';
import { questionFileError, mergeQuestionFiles, formatFileSize, insertCodeFence } from './composer.js';
import { ClassroomMedia } from './media.js';
import { ClassroomSession } from './classroom-session.js';
import { ConnectionStatus } from './connection-status.js';

const $ = id => document.getElementById(id);
const ROLE_LABEL = { admin: '관리자', instructor: '강사', student: '수강생', member: '구성원' };
const FORM_IDS = ['message-form', 'question-form', 'answer-form', 'file-form', 'membership-form', 'channel-form'];
const GROUP_GAP_MS = 5 * 60 * 1000;

let tabStorage; try { tabStorage = sessionStorage; } catch { /* tab storage unavailable */ }
const drafts = new DraftStore(tabStorage);
const pendingForms = new Set();
let cohortRequest = 0, boardRefreshTimer, questionRequest = 0, fileRequest = 0;
let notificationPoll, notificationDebounce, notificationRequest = 0;
let followMutation = null, questionFollowRequest = 0;
const inbox = { owner: null, items: [], cursor: null, unread: 0, total: 0, loading: false, more: false };
const state = {
  account: null, cohorts: [], cohort: null, channel: null, socket: null,
  space: readRoute(location.pathname).space, epoch: 0, channelEpoch: 0, questionEpoch: 0,
  channels: new Map(), lastMessage: null, lastSeenId: 0, reconnectTimer: null, reconnectNow: null,
  channelList: [], unread: new Map(), online: new Set(), members: [], holding: null, historyLoaded: false, ackTimer: null,
  messageMap: new Map(), pins: [], dms: [], newBelow: 0,
  mediaAvailable: null, accounts: [], managementTab: 'personal', academyTask: 'accounts',
  questionCursor: null, questionTotal: 0, boardStats: null, fileCursor: null, fileItems: [], fileSearch: '', fileTotal: 0,
  questions: [], question: null, filter: 'all', search: '', boardView: 'home', fileCount: null,
};

/* ---------- small helpers ---------- */
const statusTimers = new WeakMap();
const connectionStatus = new ConnectionStatus({ root: $('connection-banner'), message: $('connection-message'),
  retry: $('connection-retry'), announcement: $('connection-announcement') });
function status(message, error = false, owner = null) {
  const dialog = owner ? owner.closest('dialog') : document.querySelector('dialog[open]');
  let target = dialog?.querySelector('.dialog-status') || $('status');
  const clear = node => {
    clearTimeout(statusTimers.get(node)); statusTimers.delete(node); node.replaceChildren();
    if (node !== $('status')) node.classList.add('hidden');
  };
  if (!message) {
    if (owner) clear(target);
    else { clear($('status')); document.querySelectorAll('.dialog-status').forEach(clear); }
    return;
  }
  if (dialog && target === $('status')) {
    target = el('div', { class: 'dialog-status', role: 'alert' }); dialog.querySelector('.dialog-head').after(target);
  }
  clearTimeout(statusTimers.get(target));
  target.textContent = error ? errorMessage(message) : message;
  target.classList.remove('hidden');
  target.classList.toggle('error', error);
  if (error) target.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': '알림 닫기', text: '×', onclick: () => clear(target) }));
  if (!error || !dialog) statusTimers.set(target, setTimeout(() => clear(target), error ? 10000 : 4000));
}

function regionState(id, kind = '', message = '', retry) {
  const node = $(id);
  node.className = `region-state${message ? '' : ' hidden'}${kind === 'error' ? ' error' : ''}`;
  node.replaceChildren();
  if (message) node.append(el('span', { text: message }));
  if (retry) node.append(el('button', { type: 'button', text: '다시 시도', onclick: () => Promise.resolve(retry()).catch(error => regionState(id, 'error', error.message, retry)) }));
}
function draftKey(kind, target) { return drafts.key(state.account?.id, state.cohort?.id, kind, target); }
function saveDrafts() {
  drafts.set(draftKey('message', state.channel?.id), $('message-input').value);
  drafts.set(draftKey('answer', state.question?.id), $('answer-form').elements.body.value);
}
$('message-input').addEventListener('input', () => drafts.set(draftKey('message', state.channel?.id), $('message-input').value));
$('answer-form').addEventListener('input', () => {
  drafts.set(draftKey('answer', state.question?.id), $('answer-form').elements.body.value);
  $('answer-draft-status').textContent = '답변 초안이 이 탭에 임시 저장되었습니다.';
  updateDraftPreview('answer');
});

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
// Authors delete their own posts; instructors and admins any post in their cohort. Archived cohorts are read-only.
const isDM = () => state.channel?.kind === 'dm';
const canDelete = item => !!state.cohort && !state.cohort.archived && (item.username === state.account?.username || (isManager() && !isDM()));
// Only authors edit, so nobody's words are changed under their name.
const canEdit = item => !!state.cohort && !state.cohort.archived && item.username === state.account?.username;
function editedMark(item) {
  return item.edited_at ? el('span', { class: 'edited', text: '(수정됨)', title: `${new Date(item.edited_at).toLocaleString('ko-KR')}에 수정` }) : null;
}
// Stored text becomes formatted DOM (code, bold, links, @mentions) without ever using innerHTML.
function renderBody(node, text) { return renderRich(node, text, { me: state.account?.username }); }
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
  connectionStatus.set('idle');
}
const narrowNav = matchMedia('(max-width: 800px)');
let navOpener;
function syncNav() {
  const open = narrowNav.matches && $('hub-app').classList.contains('nav-open');
  for (const node of [document.querySelector('.rail'), $('sidebar')]) {
    node.inert = narrowNav.matches && !open;
    node.setAttribute('aria-hidden', String(node.inert));
  }
  document.querySelector('.content').inert = open;
  document.querySelectorAll('.menu-btn').forEach(button => { button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-controls', 'sidebar'); });
}
function closeNav() {
  const wasOpen = $('hub-app').classList.contains('nav-open');
  $('hub-app').classList.remove('nav-open'); syncNav();
  if (wasOpen && navOpener?.getClientRects().length) navOpener.focus();
}
function closeMembers() {
  $('hub-app').classList.remove('members-open');
  if (matchMedia('(max-width: 1100px)').matches) $('members-toggle').setAttribute('aria-pressed', 'false');
}
narrowNav.addEventListener('change', () => { if (!narrowNav.matches) $('hub-app').classList.remove('nav-open'); syncNav(); });
syncNav();

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
  const onboarding = !!state.account?.must_change_password;
  $('boot-card').classList.add('hidden');
  $('login-card').classList.toggle('hidden', !!state.account);
  $('hub-app').classList.toggle('hidden', !state.account || onboarding);
  $('first-login-card').classList.toggle('hidden', !onboarding);
  if (!onboarding) { $('first-login-form').reset(); regionState('first-login-status'); }
  if (onboarding) { $('first-login-form').elements.username.value = state.account.username; $('first-login-form').elements.current_password.focus(); }
  const name = state.account?.display_name || state.account?.username || '';
  $('account-name').textContent = name;
  $('account-label').textContent = state.account ? `@${state.account.username}` : '';
  $('user-avatar').textContent = initials(name);
  $('user-avatar').style.setProperty('--hue', hue(state.account?.username || ''));
  $('admin-card').classList.toggle('hidden', !state.account?.is_admin);
  $('accounts-card').classList.toggle('hidden', !state.account?.is_admin);
  syncNotificationSession();
}
function renderRail() {
  $('cohort-rail').replaceChildren(...state.cohorts.map(cohort => el('button', {
    class: `rail-item${cohort.archived ? ' archived' : ''}`, title: cohort.name, 'aria-label': cohort.name,
    'aria-current': String(cohort.id === state.cohort?.id), text: initials(cohort.name),
    onclick: () => { closeNav(); selectCohort(cohort.id).catch(error => status(error.message, true)); },
  })));
}
function updateControls() {
  const writable = !!state.account && !state.account.must_change_password && !!state.cohort && !state.cohort.archived;
  for (const id of FORM_IDS) {
    const editingDuringSubmit = ['question-form', 'answer-form'].includes(id) && pendingForms.has(id);
    const enabled = writable && (!pendingForms.has(id) || editingDuringSubmit) && (id !== 'message-form' || (!!state.channel && state.historyLoaded)) && (id !== 'answer-form' || !!state.question);
    for (const control of $(id).elements) control.disabled = !enabled || (editingDuringSubmit && (control.type === 'submit' || control.id === 'question-files' || control.id === 'question-discard' || control.id === 'answer-discard' || control.id === 'compose-cancel'));
  }
  $('new-post-btn').disabled = !writable;
  $('media-connect').disabled = !writable || !state.channel || state.mediaAvailable !== true;
  if (state.mediaAvailable === false && !media.room) $('media-status').textContent = isManager() ? '화면 공유가 설정되지 않았습니다. 학원 운영자에게 설정을 요청하세요.' : '아직 화면 공유를 사용할 수 없습니다. 강사에게 확인해 주세요.';
  $('media-start').classList.toggle('hidden', !isManager() && !media.canPublish);
  $('media-start').textContent = isManager() ? '화면 공유하기' : '화면 선택하고 공유';
  const student = state.cohort?.role === 'student';
  const ownRequest = presentationState.requests?.find(r => r.account_id === state.account?.id);
  $('media-request').classList.toggle('hidden', !student || !classroomSession.active || media.canPublish);
  $('media-request').disabled = !writable || !media.connected || ['pending', 'approved'].includes(ownRequest?.status);
  $('media-cancel-request').classList.toggle('hidden', !student || !classroomSession.active?.requestToken || !['pending', 'approved'].includes(ownRequest?.status));
  $('media-start').disabled = !writable || !media.connected || !media.canPublish || media.publishing || media.sharing;
}
function resetContent() {
  saveDrafts(); $('message-input').value = ''; $('answer-form').elements.body.value = '';
  $('question-form').reset(); selectedQuestionFiles = []; uploadedQuestionFiles = new WeakMap(); renderSelectedQuestionFiles();
  setDraftPreview('question', false, false); setDraftPreview('answer', false, false);
  clearTimeout(boardRefreshTimer); questionRequest++; fileRequest++;
  for (const id of ['chat-state', 'board-state', 'board-update', 'files-state']) regionState(id);
  $('history-more').classList.add('hidden');
  $('history-latest').classList.add('hidden');
  state.epoch++; state.channelEpoch++; state.questionEpoch++;
  closeChat(); void leaveMedia().catch(error => status(error.message, true));
  state.channel = null; state.question = null; state.questions = []; state.lastMessage = null; state.lastSeenId = 0; state.fileCount = null;
  state.channelList = []; state.unread = new Map(); state.online = new Set(); state.members = []; state.holding = null; state.historyLoaded = false;
  state.messageMap = new Map(); state.pins = []; state.dms = []; state.newBelow = 0; state.questionCursor = null; state.boardStats = null; state.fileItems = []; state.fileCursor = null; renderPins();
  clearTimeout(state.ackTimer); updateTitle();
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
  const admin = !!state.account?.is_admin;
  $('empty-heading').textContent = admin ? '첫 수강반을 만들어 주세요' : '참여 중인 수강반이 없습니다';
  $('empty-description').textContent = admin ? '수강반을 만들고 강사·학생 계정과 채널을 추가하면 시작할 수 있습니다.' : '목록에서 참여 중인 수강반을 선택하세요. 목록에 없다면 강사 또는 학원 운영자에게 배정을 요청하세요.';
  $('empty-create').classList.toggle('hidden', !admin);
  $('hub-app').classList.toggle('board-mode', !!cohort && !chat);
  $('board-nav').classList.toggle('hidden', !cohort || chat);
  $('class-manage-btn').classList.toggle('hidden', !cohort || !isManager());
  $('academy-manage-btn').classList.toggle('hidden', !state.account?.is_admin);
  $('cohort-name').textContent = cohort?.name || '마디';
  $('role-label').textContent = cohort ? `${ROLE_LABEL[cohort.role] || '구성원'}${cohort.archived ? ' · 종료됨' : ''}` : '';
  $('role-label').className = `role-chip ${roleClass(cohort?.role)}`;
  const manage = !!cohort && isManager();
  $('manage-card').classList.toggle('hidden', !manage);
  $('cohort-status').classList.toggle('hidden', !cohort || !state.account?.is_admin);
  $('add-channel-btn').classList.toggle('hidden', !manage || !!cohort?.archived);
  $('media-start').classList.toggle('hidden', !manage);
  $('media-classroom-label').classList.add('hidden');
  const instructorOption = $('membership-form').elements.role.querySelector('[value="instructor"]');
  instructorOption.disabled = instructorOption.hidden = !state.account?.is_admin;
  if (!state.account?.is_admin) $('membership-form').elements.role.value = 'student';
  for (const space of ['chat', 'board']) {
    const link = $(`${space}-link`);
    link.href = cohort ? spaceUrl(cohort.slug, space) : '/hub';
    if (space === state.space) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    $(`${space}-cohort`).textContent = cohort?.name || '';
  }
  updateTitle();
  renderRail();
  setManagementTab(state.managementTab);
  updateControls();
}

/* ---------- boot / cohorts / spaces ---------- */
function requireLogin(message = '로그인이 만료되었습니다. 다시 로그인해 주세요.') {
  if (!state.account) return;
  const username = state.account.username;
  saveDrafts();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  resetContent(); state.account = null; state.cohort = null; state.cohorts = []; state.accounts = [];
  for (const id of FORM_IDS) $(id).reset();
  showAccount(); showSpace(); closeNav();
  $('login-message').textContent = message; $('login-message').classList.remove('hidden');
  $('login-form').elements.username.value = username; $('login-form').elements.password.value = '';
  $('login-form').elements.password.focus();
}
addEventListener('madi:unauthorized', () => requireLogin());
async function boot() {
  $('boot-card').classList.remove('hidden'); $('login-card').classList.add('hidden'); $('hub-app').classList.add('hidden');
  $('boot-message').textContent = '학습 공간을 불러오고 있습니다…'; $('boot-retry').classList.add('hidden');
  try { state.account = await api('/me'); }
  catch (error) {
    if (error.status === 401) { state.account = null; showAccount(); }
    else { $('boot-message').textContent = '서비스에 연결할 수 없습니다. 네트워크 상태를 확인하고 다시 시도하세요.'; $('boot-retry').classList.remove('hidden'); }
    return;
  }
  showAccount();
  if (state.account.must_change_password) return;
  void loadMediaAvailability();
  try { await loadCohorts(); } catch (error) { status(error.message, true); }
}
$('boot-retry').addEventListener('click', boot);
$('empty-create').addEventListener('click', async () => { await openManagement('academy', 'cohorts'); $('cohort-form').elements.slug.focus(); });

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
    if (route.slug) status('이 수강반에 접근할 수 없습니다. 참여 중인 수강반을 선택하세요.', true);
    return;
  }
  await selectCohort(chosen.id, 'replace');
}
async function selectCohort(id, historyMode = 'push') {
  const next = state.cohorts.find(c => c.id === Number(id));
  if (!next) return;
  if (state.cohort?.id !== next.id) {
    saveDrafts();
    for (const formId of FORM_IDS) $(formId).reset();
    state.filter = 'all'; state.search = ''; $('post-search').value = ''; syncFilterButtons();
  }
  state.cohort = next;
  const url = spaceUrl(next.slug, state.space) + (historyMode === 'replace' ? location.search + location.hash : '');
  if (historyMode === 'replace') history.replaceState(null, '', url);
  else if (location.pathname !== url) history.pushState(null, '', url);
  await loadSpace();
}
async function loadSpace() {
  status('');
  resetContent(); showSpace();
  const epoch = state.epoch;
  try {
    connectChat(state.cohort);
    if (state.space === 'chat') { await Promise.all([loadMembers(), loadDMs()]); await loadChannels(); }
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
for (const button of document.querySelectorAll('.menu-btn')) button.addEventListener('click', () => { navOpener = button; $('hub-app').classList.add('nav-open'); syncNav(); $(`${state.space}-link`).focus(); });
$('scrim').addEventListener('click', closeNav);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeNav(); closeMembers(); }
  if (event.key === 'Tab' && narrowNav.matches && $('hub-app').classList.contains('nav-open')) {
    const nodes = [...document.querySelectorAll('.rail button, .rail a, #sidebar button, #sidebar a, #sidebar input')].filter(n => !n.disabled && n.getClientRects().length && !n.closest('.hidden'));
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

/* ---------- chat ---------- */
async function loadChannels() {
  const epoch = state.epoch, cohort = state.cohort;
  const [channels, counts] = await Promise.all([api(`/cohorts/${cohort.id}/channels`), api(`/cohorts/${cohort.id}/unread`).catch(() => [])]);
  if (epoch !== state.epoch) return;
  state.channelList = channels;
  state.unread = new Map(counts.map(c => [c.channel_id, c]));
  renderChannelList();
  const requested = Number(new URL(location.href).searchParams.get('channel'));
  const selected = [...channels, ...state.dms].find(c => c.id === (requested || state.channels.get(cohort.id))) || (!requested && channels[0]);
  if (selected) await selectChannel(selected, 'replace');
  else if (requested) regionState('chat-state', 'error', '이 대화에 접근할 수 없거나 더 이상 존재하지 않습니다.', async () => { history.replaceState(null, '', spaceUrl(cohort.slug, 'chat')); await loadChannels(); });
  else {
    $('messages').append(el('p', { class: 'muted', text: cohort.archived ? '종료된 수강반이라 채널을 만들 수 없습니다.' : isManager() ? '채널 목록 옆의 + 버튼으로 첫 채널을 만드세요.' : '강사에게 채널 개설을 요청하세요.' }));
    updateControls();
  }
}
function renderChannelList() {
  const list = $('channel-list');
  if (!state.channelList.length) { list.replaceChildren(el('p', { class: 'muted', text: '아직 채널이 없습니다.' })); return; }
  list.replaceChildren(...state.channelList.map(channel => {
    const active = channel.id === state.channel?.id;
    const counts = active ? null : state.unread.get(channel.id);
    const unread = Number(counts?.unread || 0), mentions = Number(counts?.mentions || 0);
    const label = [channel.name, unread ? `안 읽은 메시지 ${unread}개` : '', mentions ? `나를 멘션 ${mentions}개` : ''].filter(Boolean).join(', ');
    return el('button', {
      class: `${active ? 'active' : ''}${unread ? ' unread' : ''}`, dataset: { id: channel.id }, 'aria-pressed': String(active), 'aria-label': label,
      onclick: () => { closeNav(); selectChannel(channel).catch(error => status(error.message, true)); },
    }, el('span', { class: 'hash', 'aria-hidden': 'true', text: '#' }), el('span', { class: 'channel-name', text: channel.name }),
      unread ? el('span', { class: `count${mentions ? ' mention' : ''}`, 'aria-hidden': 'true', text: mentions ? `@${mentions}` : unread > 99 ? '99+' : String(unread) }) : null);
  }));
  renderDMList();
  updateTitle();
}
async function loadDMs() {
  const epoch = state.epoch, cohort = state.cohort;
  const dms = await api(`/cohorts/${cohort.id}/dms`);
  if (epoch !== state.epoch) return;
  state.dms = dms.map(dmChannel);
  renderDMList();
}
function dmChannel(dm) {
  return { id: dm.id, kind: 'dm', name: dm.other_display_name, username: dm.other_username, otherId: dm.other_id, active: dm.other_active };
}
function renderDMList() {
  const list = $('dm-list');
  if (!state.dms.length) { list.replaceChildren(el('p', { class: 'muted', text: '구성원 이름을 누르면 DM을 보낼 수 있어요.' })); return; }
  list.replaceChildren(...state.dms.map(dm => {
    const active = dm.id === state.channel?.id, unread = active ? 0 : Number(state.unread.get(dm.id)?.unread || 0);
    return el('button', {
      class: `${active ? 'active' : ''}${unread ? ' unread' : ''}`, 'aria-pressed': String(active),
      'aria-label': `${dm.name}님과의 DM${unread ? `, 안 읽은 메시지 ${unread}개` : ''}`,
      onclick: () => { closeNav(); selectChannel(dm).catch(error => status(error.message, true)); },
    }, el('span', { class: 'presence-wrap' }, avatar(dm.name, dm.username, true), el('span', { class: `presence-dot${state.online.has(dm.otherId) ? ' on' : ''}`, 'aria-hidden': 'true' })),
      el('span', { class: 'channel-name', text: dm.name }),
      unread ? el('span', { class: 'count mention', 'aria-hidden': 'true', text: unread > 99 ? '99+' : String(unread) }) : null);
  }));
}
async function openDM(member) {
  if (!state.cohort || member.id === state.account?.id) return;
  try {
    const dm = dmChannel(await api(`/cohorts/${state.cohort.id}/dms`, { method: 'POST', json: { account_id: member.id } }));
    if (!state.dms.some(d => d.id === dm.id)) state.dms.unshift(dm);
    $('dm-picker').close(); closeNav(); closeMembers();
    await selectChannel(dm);
    $('message-input').focus();
  } catch (error) { status(error.message, true); }
}
function renderDMCandidates() {
  const term = $('dm-filter').value.trim().toLowerCase();
  const people = state.members.filter(m => m.id !== state.account?.id)
    .filter(m => !term || `${m.display_name} ${m.username}`.toLowerCase().includes(term));
  $('dm-candidates').replaceChildren(...(people.length ? people.map(m => el('li', {},
    el('button', { type: 'button', class: 'dm-candidate', onclick: () => openDM(m) },
      avatar(m.display_name, m.username, true), el('span', { class: 'who', text: `${m.display_name} (@${m.username})` }), roleTag(m.role),
      state.online.has(m.id) ? el('span', { class: 'tag online-tag', text: '접속 중' }) : null))) : [el('li', { class: 'muted', text: '찾는 구성원이 없습니다.' })]));
}
$('new-dm-btn').addEventListener('click', () => { $('dm-filter').value = ''; renderDMCandidates(); $('dm-picker').showModal(); $('dm-filter').focus(); });
$('dm-filter').addEventListener('input', renderDMCandidates);
$('dm-picker-close').addEventListener('click', () => $('dm-picker').close());
function updateTitle() {
  const cohort = state.cohort, chat = state.space === 'chat';
  const total = [...state.unread.entries()].reduce((sum, [id, c]) => sum + (id === state.channel?.id ? 0 : Number(c.unread || 0)), 0);
  document.title = `${total ? `(${total > 99 ? '99+' : total}) ` : ''}마디 · ${chat ? '채팅' : 'Q&A 게시판'}${cohort ? ` · ${cohort.name}` : ''}`;
}
async function loadMembers() {
  const epoch = state.epoch, cohort = state.cohort;
  let members;
  try { members = await api(`/cohorts/${cohort.id}/members`); } catch { if (epoch === state.epoch) $('member-list').replaceChildren(el('p', { text: '구성원을 불러오지 못했습니다.' }), el('button', { text: '다시 시도', onclick: loadMembers })); return; }
  if (epoch !== state.epoch) return;
  state.members = members;
  renderMembers();
}
function renderMembers() {
  const groups = [['instructor', '강사'], ['student', '수강생']];
  const nodes = [];
  for (const [role, label] of groups) {
    const people = state.members.filter(m => m.role === role)
      .sort((a, b) => Number(state.online.has(b.id)) - Number(state.online.has(a.id)) || a.display_name.localeCompare(b.display_name, 'ko'));
    if (!people.length) continue;
    const online = people.filter(p => state.online.has(p.id)).length;
    nodes.push(el('h3', { text: `${label} — ${people.length}명${online ? ` · 접속 ${online}` : ''}` }));
    for (const person of people) {
      const on = state.online.has(person.id);
      const self = person.id === state.account?.id;
      nodes.push(el(self ? 'div' : 'button', { class: `member ${roleClass(role)}${on ? ' online' : ''}`, type: self ? null : 'button',
          title: self ? '나' : `@${person.username}${on ? ' · 접속 중' : ''} · 눌러서 DM 보내기`, onclick: self ? null : () => openDM(person) },
        el('span', { class: 'presence-wrap' }, avatar(person.display_name, person.username, true), el('span', { class: 'presence-dot', 'aria-hidden': 'true' })),
        el('span', { text: self ? `${person.display_name} (나)` : person.display_name }), on ? el('span', { class: 'visually-hidden', text: '(접속 중)' }) : null,
        self ? null : el('span', { class: 'dm-hint', 'aria-hidden': 'true', text: 'DM' })));
    }
  }
  if (!nodes.length) nodes.push(el('p', { class: 'muted', text: '구성원이 없습니다.' }));
  $('member-list').replaceChildren(...nodes);
}
async function selectChannel(channel, historyMode = 'push') {
  saveDrafts();
  const epoch = state.epoch, channelEpoch = ++state.channelEpoch, cohort = state.cohort;
  await leaveMedia();
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  state.channel = channel;
  $('history-latest').classList.add('hidden');
  $('message-input').value = drafts.get(draftKey('message', channel.id)); $('message-input').style.height = '';
  const channelUrl = new URL(spaceUrl(cohort.slug, 'chat'), location.origin); channelUrl.searchParams.set('channel', channel.id);
  if (historyMode === 'replace' && /^#message-\d+$/.test(location.hash)) channelUrl.hash = location.hash;
  if (location.pathname + location.search + location.hash !== channelUrl.pathname + channelUrl.search + channelUrl.hash) history[historyMode === 'replace' ? 'replaceState' : 'pushState'](null, '', channelUrl.pathname + channelUrl.search + channelUrl.hash);
  regionState('chat-state', 'loading', '대화를 불러오고 있습니다…');
  state.channels.set(cohort.id, channel.id); state.lastMessage = null; state.lastSeenId = 0;
  state.historyLoaded = false; state.holding = []; state.messageMap = new Map(); state.pins = []; renderPins();
  const dm = channel.kind === 'dm';
  $('channel-heading').textContent = dm ? `@ ${channel.name}` : `# ${channel.name}`;
  $('message-input').placeholder = dm ? `${channel.name}님에게 메시지 보내기` : `#${channel.name}에 메시지 보내기`;
  $('stage-toggle').classList.toggle('hidden', dm);
  if (dm) { $('stage').classList.add('hidden'); $('stage-toggle').setAttribute('aria-pressed', 'false'); }
  $('messages').replaceChildren(dm
    ? el('div', { class: 'channel-intro' }, avatar(channel.name, channel.username),
        el('h3', { text: `${channel.name}님과의 DM` }),
        el('p', { class: 'muted', text: '🔒 두 사람만 볼 수 있는 대화입니다. 강사와 관리자도 볼 수 없어요.' }))
    : el('div', { class: 'channel-intro' },
        el('div', { class: 'hash-big', 'aria-hidden': 'true', text: '#' }),
        el('h3', { text: `#${channel.name}에 오신 것을 환영합니다` }),
        el('p', { class: 'muted', text: `${cohort.name}의 #${channel.name} 채널입니다. 이전 메시지 불러오기로 지난 대화도 확인할 수 있습니다.` })));
  renderChannelList(); updateControls();
  if (!dm) void loadMediaClassrooms().catch(error => status(error.message, true));
  // Live messages for this channel are held while its history loads, then applied in order.
  let messages;
  try { messages = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages`); }
  catch (error) { if (epoch === state.epoch && channelEpoch === state.channelEpoch) { state.holding = null; regionState('chat-state', 'error', '대화 기록을 불러오지 못했습니다.', () => selectChannel(channel, 'replace')); } return; }
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  const lastRead = Number(state.unread.get(channel.id)?.last_read_id ?? Infinity);
  const firstNew = messages.find(m => m.id > lastRead && m.username !== state.account?.username);
  for (const message of messages) {
    // The divider goes in first so the first new message starts its own group, author shown.
    if (message === firstNew) $('messages').append(el('div', { class: 'new-divider', role: 'separator', 'aria-label': '여기부터 새 메시지' }, el('span', { text: '새 메시지' })));
    receive(message);
  }
  state.newBelow = 0; showJump();
  if (firstNew) $('messages').querySelector('.new-divider').scrollIntoView({ block: 'center' });
  state.historyLoaded = true; regionState('chat-state'); $('history-more').classList.toggle('hidden', messages.length < 100); updateControls();
  state.pins = messages.filter(m => m.pinned_at); renderPins(); loadPins().catch(() => {});
  flushHolding();
  const linkedMessage = Number((location.hash.match(/^#message-(\d+)$/) || [])[1]);
  if (linkedMessage) {
    state.historyLoaded = false; updateControls(); await jumpTo(linkedMessage);
    if (channelEpoch !== state.channelEpoch) return;
    state.historyLoaded = true; updateControls();
  }
  ackRead(true);
}
function receive(message) { state.lastSeenId = Math.max(state.lastSeenId, message.id); appendMessage(message); }
function flushHolding() {
  const held = state.holding || [];
  state.holding = null;
  for (const event of held) applyChannelEvent(event);
}
function applyChannelEvent(event) {
  if (event.type === 'message') receive(event.message);
  else if (event.type === 'message_deleted') removeMessage(event.id);
  else if (event.type === 'message_edited') updateMessage(event.message);
  else if (event.type === 'reactions') { const message = state.messageMap.get(event.message_id); if (message) updateMessage({ ...message, reactions: event.reactions }); }
  else if (event.type === 'message_pinned') { updateMessage(event.message); loadPins().catch(() => {}); }
}
function handleEvent(event) {
  if (['message', 'message_deleted', 'board_changed', 'membership_changed', 'notifications_changed'].includes(event.type)) queueNotificationRefresh();
  if (event.type === 'notifications_changed') return;
  if (event.type === 'board_changed' || event.type === 'files_changed') {
    if (state.space === 'board') { clearTimeout(boardRefreshTimer); boardRefreshTimer = setTimeout(() => refreshBoard().catch(() => regionState('board-update', 'error', '새 내용을 불러오지 못했습니다.', refreshBoard)), 150); }
    return;
  }
  if (event.type === 'membership_changed') {
    if (event.account_id === state.account?.id) loadCohorts(state.cohort?.id).catch(error => status(error.message, true));
    else if (state.space === 'chat') void loadMembers();
    return;
  }
  if (event.type === 'media_updated') {
    if (event.channel_id === state.channel?.id && classroomSession.active) void classroomSession.check().catch(() => classroomSession.onLost());
    return;
  }
  if (event.type === 'presence') { state.online = new Set(event.online); renderMembers(); renderDMList(); return; }
  if (event.channel_id === state.channel?.id) {
    if (state.holding) state.holding.push(event);
    else { applyChannelEvent(event); if (event.type === 'message') ackRead(); }
    return;
  }
  if (event.type === 'message' && !state.channelList.some(c => c.id === event.channel_id) && !state.dms.some(d => d.id === event.channel_id)) {
    loadDMs().catch(() => {});  // someone started a DM with me
  }
  if (event.type === 'message' && event.message.username !== state.account?.username) {
    const counts = state.unread.get(event.channel_id) || { unread: 0, mentions: 0 };
    const mentioned = event.message.body.toLowerCase().includes(`@${state.account.username.toLowerCase()}`);
    state.unread.set(event.channel_id, { unread: Number(counts.unread) + 1, mentions: Number(counts.mentions) + (mentioned ? 1 : 0) });
    renderChannelList();
  }
}
async function loadUnread() {
  const epoch = state.epoch, cohort = state.cohort;
  const counts = await api(`/cohorts/${cohort.id}/unread`);
  if (epoch !== state.epoch) return;
  state.unread = new Map(counts.map(c => [c.channel_id, c]));
  renderChannelList();
}
// Mark the open channel read up to the newest message shown, while the tab is visible.
function ackRead(now = false) {
  clearTimeout(state.ackTimer);
  const send = async () => {
    const cohort = state.cohort, channel = state.channel, epoch = state.epoch;
    if (!cohort || !channel || !state.historyLoaded || document.visibilityState !== 'visible') return;
    const box = $('messages'), rect = box.getBoundingClientRect();
    const visible = [...box.querySelectorAll('[data-message-id]')].filter(row => { const r = row.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom; });
    const upTo = Math.max(0, ...visible.map(row => Number(row.dataset.messageId)));
    if (!upTo) return;
    try { await api(`/cohorts/${cohort.id}/channels/${channel.id}/read`, { method: 'POST', json: { message_id: upTo } }); if (epoch === state.epoch && state.channel === channel) await loadUnread(); } catch { /* retry on the next scroll or message */ }
  };
  if (now) void send(); else state.ackTimer = setTimeout(send, 800);
}
// After a (re)connect: fetch what the open channel missed, and refresh every channel's unread count.
async function catchUp() {
  const cohort = state.cohort, channel = state.channel, channelEpoch = state.channelEpoch;
  if (!channel || !state.historyLoaded) return;  // a history load in progress already covers it
  state.holding = state.holding || [];
  const missed = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages?after=${state.lastSeenId}`);
  if (channelEpoch !== state.channelEpoch) return;
  missed.forEach(receive);
  flushHolding();
  if (missed.length) ackRead();
}
const REVOKED_MESSAGE = '로그인이 만료되었거나 이 수강반에 접근할 수 없어 채팅 연결이 종료되었습니다. 다시 로그인하세요.';
// One socket per cohort carries every channel's events. After each (re)connect
// the open channel catches up on anything missed, and drops reconnect with backoff.
function connectChat(cohort, retry = 0) {
  const epoch = state.epoch;
  const current = () => epoch === state.epoch;
  const socket = cohortSocket(cohort.id); state.socket = socket;
  connectionStatus.set(navigator.onLine === false ? 'offline' : retry ? 'reconnecting' : 'connecting');
  let opened = false;
  socket.onmessage = event => { if (state.socket === socket) handleEvent(JSON.parse(event.data)); };
  socket.onopen = async () => {
    if (state.socket !== socket || !current()) return;
    opened = true;
    queueNotificationRefresh();
    try {
      await Promise.all([state.space === 'board' ? (retry ? refreshBoard() : Promise.resolve()) : catchUp(), loadUnread()]);
      if (state.socket === socket && current()) connectionStatus.set('connected');
    } catch (error) {
      if (state.socket === socket) { socket.close(); }
    }
  };
  socket.onclose = async event => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.online = new Set(); renderMembers();
    // 1008: the server revoked this session or cohort access (logout elsewhere, expiry, removal).
    if (event.code === 1008) { requireLogin(REVOKED_MESSAGE); return; }
    // A handshake refused before opening looks like a network error; check the session.
    if (!opened) {
      try { await api('/me'); } catch (error) {
        // 401: the session is gone. Anything else (server down, no network) is worth retrying.
        if (error.status === 401) { if (current()) requireLogin(REVOKED_MESSAGE); return; }
      }
    }
    if (!current()) return;
    const next = opened ? 1 : retry + 1;
    const delay = Math.min(30000, 500 * 2 ** next) * (0.75 + Math.random() / 2);
    const reconnect = () => {
      clearTimeout(state.reconnectTimer); state.reconnectTimer = null; state.reconnectNow = null;
      if (current()) connectChat(cohort, next);
    };
    state.reconnectTimer = setTimeout(reconnect, delay); state.reconnectNow = reconnect;
    connectionStatus.set(navigator.onLine === false ? 'offline' : 'reconnecting', reconnect);
  };
}
// Skip the wait when the network or the tab comes back.
addEventListener('online', () => state.reconnectNow?.());
window.addEventListener('offline', () => { if (state.cohort) connectionStatus.set('offline', state.reconnectNow); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { state.reconnectNow?.(); if (state.space === 'board') void refreshBoard().catch(() => {}); else if (state.historyLoaded) ackRead(true); } });
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
  const data = { messageId: message.id, username: message.username, createdAt: message.created_at };
  state.messageMap.set(message.id, message);
  const body = el('div', { class: 'msg-body' }, ...bodyParts(message));
  const row = grouped
    ? el('div', { class: 'msg', dataset: data },
        el('span', { class: 'hover-time', 'aria-hidden': 'true', text: timeFmt.format(when) }), body)
    : el('div', { class: 'msg head', dataset: data },
        avatar(name, message.username),
        el('div', { class: 'msg-head' }, el('strong', { class: roleClass(message.role), text: name, title: `@${message.username}` }), roleTag(message.role), time),
        body);
  row.tabIndex = 0; row.setAttribute('aria-label', `${name} · ${stamp(message.created_at)}`);
  row.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); row.querySelector('.msg-actions button')?.focus(); } });
  row.append(reactionsNode(message));
  const actions = messageActions(message, row);
  if (actions) row.append(actions);
  box.append(row);
  state.lastMessage = message;
  if (nearBottom || message.username === state.account?.username) box.scrollTop = box.scrollHeight;
  else if (state.historyLoaded) { state.newBelow += 1; showJump(); }
}
function showJump() {
  const n = state.newBelow;
  $('jump-new').textContent = `↓ 새 메시지 ${n}개`;
  $('jump-new').classList.toggle('hidden', !n);
}
$('jump-new').addEventListener('click', () => { const box = $('messages'); box.scrollTop = box.scrollHeight; });
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 60 && state.newBelow) { state.newBelow = 0; showJump(); }
  if (state.historyLoaded) ackRead();
});
function messageActions(message, row) {
  const name = message.display_name || message.username;
  const writable = !!state.account && !!state.cohort && !state.cohort.archived;
  const bar = el('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': '메시지 작업' },
    writable ? el('button', { type: 'button', text: '😀', title: '반응 추가', 'aria-label': '반응 추가', onclick: event => openReactionPicker(message, event.currentTarget) }) : null,
    writable && (isManager() || isDM()) ? el('button', { type: 'button', text: message.pinned_at ? '고정 해제' : '📌 고정', 'aria-label': message.pinned_at ? '고정 해제' : '메시지 고정',
      onclick: () => setPinned(message, !message.pinned_at) }) : null,
    canEdit(message) ? el('button', { type: 'button', text: '수정', 'aria-label': '내 메시지 수정', onclick: () => startEditMessage(message, row) }) : null,
    canDelete(message) ? el('button', { type: 'button', class: 'danger-text', text: '삭제', 'aria-label': `${name}의 메시지 삭제`, onclick: () => deleteMessage(message) }) : null);
  return bar.childElementCount ? bar : null;
}
function bodyParts(message) {
  return [message.pinned_at ? el('span', { class: 'pin-flag', text: '📌 고정됨' }) : null,
    renderBody(el('span', { class: 'msg-text' }), message.body), editedMark(message)].filter(Boolean);
}
function updateMessage(message) {
  state.messageMap.set(message.id, message);
  const row = $('messages').querySelector(`[data-message-id="${message.id}"]`);
  if (!row) return;
  if (!row.classList.contains('editing')) row.querySelector('.msg-body').replaceChildren(...bodyParts(message));
  row.querySelector('.reactions').replaceWith(reactionsNode(message));
  const actions = messageActions(message, row);
  row.querySelector('.msg-actions')?.remove();
  if (actions) row.append(actions);
}
const REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '❓'];
function nameOf(id) {
  if (id === state.account?.id) return '나';
  return state.members.find(m => m.id === id)?.display_name || '관리자';
}
function reactionsNode(message) {
  const readOnly = !state.cohort || state.cohort.archived;
  return el('div', { class: 'reactions' }, ...(message.reactions || []).map(reaction => {
    const mine = reaction.accounts.includes(state.account?.id), names = reaction.accounts.map(nameOf).join(', ');
    return el('button', { type: 'button', class: `reaction${mine ? ' mine' : ''}`, 'aria-pressed': String(mine), disabled: readOnly,
      title: names, 'aria-label': `${reaction.emoji} ${reaction.accounts.length}명 (${names})${mine ? ', 누르면 취소' : ''}`,
      onclick: () => react(message, reaction.emoji) }, el('span', { text: reaction.emoji }), el('span', { class: 'n', text: String(reaction.accounts.length) }));
  }));
}
async function react(message, emoji) {
  try {
    const reactions = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages/${message.id}/reactions`, { method: 'POST', json: { emoji } });
    updateMessage({ ...state.messageMap.get(message.id), reactions });
  } catch (error) { status(error.message, true); }
}
function openReactionPicker(message, anchor) {
  document.querySelector('.reaction-picker')?.remove();
  const picker = el('div', { class: 'reaction-picker', role: 'menu', 'aria-label': '반응 선택' },
    ...REACTIONS.map(emoji => el('button', { type: 'button', role: 'menuitem', text: emoji, 'aria-label': `${emoji} 반응`,
      onclick: () => { picker.remove(); react(message, emoji); } })));
  picker.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); picker.remove(); anchor.focus(); } });
  anchor.closest('.msg').append(picker);
  picker.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', function away(event) {
    if (!picker.contains(event.target)) { picker.remove(); document.removeEventListener('click', away); }
  }), 0);
}
async function setPinned(message, pinned) {
  try {
    const updated = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages/${message.id}/pin`, { method: 'POST', json: { pinned } });
    updateMessage(updated); await loadPins();
    status(pinned ? '메시지를 고정했습니다.' : '고정을 해제했습니다.');
  } catch (error) { status(error.message, true); }
}
async function loadPins() {
  const cohort = state.cohort, channel = state.channel;
  if (!cohort || !channel) return;
  const pins = await api(`/cohorts/${cohort.id}/channels/${channel.id}/pins`);
  if (state.channel !== channel) return;
  state.pins = pins; renderPins();
}
function renderPins() {
  const count = state.pins.length;
  $('pins-count').textContent = String(count); $('pins-count').classList.toggle('hidden', !count);
  $('pins-toggle').setAttribute('aria-description', `${count}개`);
  $('pins-list').replaceChildren(...(count ? state.pins.map(pin => el('li', {},
    el('button', { type: 'button', class: 'pin-item', onclick: () => jumpTo(pin.id) },
      el('strong', { text: pin.display_name || pin.username }), el('small', { class: 'muted', text: ` · ${stamp(pin.created_at)}` }),
      el('span', { class: 'pin-text', text: pin.body })))) : [el('li', { class: 'muted', text: isManager() ? '고정된 메시지가 없습니다. 메시지에 마우스를 올려 📌 고정을 누르세요.' : '고정된 메시지가 없습니다.' })]));
}
function renderHistory(rows) {
  state.messageMap = new Map(); state.lastMessage = null;
  $('messages').replaceChildren();
  for (const message of rows) receive(message);
}
async function jumpTo(messageId) {
  let row = $('messages').querySelector(`[data-message-id="${messageId}"]`);
  if (!row) {
    const cohort = state.cohort, channel = state.channel, epoch = state.channelEpoch;
    try {
      const rows = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages?around=${messageId}`);
      if (epoch !== state.channelEpoch) return;
      renderHistory(rows); $('history-more').classList.remove('hidden'); $('history-latest').classList.remove('hidden');
      row = $('messages').querySelector(`[data-message-id="${messageId}"]`);
    } catch { regionState('chat-state', 'error', '고정 메시지를 불러오지 못했습니다.', () => jumpTo(messageId)); return; }
  }
  if (!row) { regionState('chat-state', 'error', '삭제되었거나 접근할 수 없는 메시지입니다.'); return; }
  row.scrollIntoView({ block: 'center', behavior: 'instant' }); row.focus({ preventScroll: true });
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600);
}
$('history-latest').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search); void selectChannel(state.channel, 'replace'); });
$('history-more').addEventListener('click', async () => {
  const channel = state.channel, cohort = state.cohort, epoch = state.channelEpoch;
  const before = Math.min(...state.messageMap.keys());
  if (!Number.isFinite(before)) return;
  $('history-more').disabled = true;
  try {
    const older = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages?before=${before}`);
    if (epoch !== state.channelEpoch) return;
    const box = $('messages'), height = box.scrollHeight, top = box.scrollTop;
    const rows = [...new Map([...older, ...state.messageMap.values()].map(message => [message.id, message])).values()].sort((a, b) => a.id - b.id);
    renderHistory(rows); box.scrollTop = top + box.scrollHeight - height;
    $('history-more').classList.toggle('hidden', older.length < 100); regionState('chat-state');
  } catch { regionState('chat-state', 'error', '이전 메시지를 불러오지 못했습니다.', () => $('history-more').click()); }
  finally { $('history-more').disabled = false; }
});
$('pins-toggle').addEventListener('click', event => {
  const hidden = $('pins-panel').classList.toggle('hidden');
  event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  if (!hidden) loadPins().catch(error => status(error.message, true));
});
function startEditMessage(message, row) {
  if (row.classList.contains('editing')) return;
  const body = row.querySelector('.msg-body'), original = [...body.childNodes];
  const current = message.body;
  const input = el('textarea', { class: 'edit-input', rows: 2, maxlength: 2000, 'aria-label': '메시지 수정' });
  input.value = current;
  const done = () => { row.classList.remove('editing'); body.replaceChildren(...original); };
  const save = async () => {
    const text = input.value.trim();
    if (!text || text === current) { done(); return; }
    try {
      const updated = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages/${message.id}`, { method: 'PATCH', json: { body: text } });
      Object.assign(message, updated); row.classList.remove('editing'); updateMessage(updated);
    } catch (error) { status(error.message, true); }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(); }
  });
  row.classList.add('editing');
  body.replaceChildren(input, el('small', { class: 'edit-hint', text: 'Enter 저장 · Esc 취소 · Shift+Enter 줄바꿈' }));
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}
function removeMessage(id) {
  const box = $('messages'), row = box.querySelector(`[data-message-id="${id}"]`);
  if (!row) return;
  const next = row.nextElementSibling, prev = row.previousElementSibling;
  // If the author header goes, the next message in the same group takes it over.
  if (row.classList.contains('head') && next?.classList.contains('msg') && !next.classList.contains('head')) {
    const time = row.querySelector('.msg-head time'), when = new Date(next.dataset.createdAt);
    time.dateTime = next.dataset.createdAt; time.textContent = stamp(next.dataset.createdAt); time.title = when.toLocaleString('ko-KR');
    next.querySelector('.hover-time')?.remove();
    next.classList.add('head');
    next.prepend(row.querySelector('.avatar'), row.querySelector('.msg-head'));
  }
  row.remove();
  if (prev?.classList.contains('day-divider') && (!next || next.classList.contains('day-divider'))) prev.remove();
  // New messages group against the last one still shown.
  const last = [...box.querySelectorAll('.msg')].at(-1);
  state.lastMessage = last ? { username: last.dataset.username, created_at: last.dataset.createdAt } : null;
}
async function deleteMessage(message) {
  if (!confirm('이 메시지를 삭제할까요? 모든 사람의 화면에서 사라집니다.')) return;
  try {
    await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages/${message.id}`, { method: 'DELETE' });
    removeMessage(message.id);
  } catch (error) { status(error.message, true); }
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
  void loadMediaClassrooms().catch(error => status(error.message, true));
  const hidden = $('stage').classList.toggle('hidden');
  event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  $('messages').scrollTop = $('messages').scrollHeight;
});

/* ---------- board ---------- */
function boardUrl(view, questionId) {
  const url = new URL(spaceUrl(state.cohort.slug, 'board'), location.origin);
  if (state.filter !== 'all') url.searchParams.set('filter', state.filter);
  if (state.search) url.searchParams.set('q', state.search);
  if (view === 'files' || view === 'compose') url.searchParams.set('view', view);
  if (view === 'files' && state.fileSearch) url.searchParams.set('file', state.fileSearch);
  if (view === 'post') url.hash = `post-${questionId}`;
  return url.pathname + url.search + url.hash;
}
function writeBoardUrl(view, questionId, replace = false) {
  const next = boardUrl(view, questionId);
  if (location.pathname + location.search + location.hash !== next) history[replace ? 'replaceState' : 'pushState'](null, '', next);
}
async function loadBoard() {
  const url = new URL(location.href);
  const epoch = state.epoch;
  const { questionId: postId, answerId } = readAnswerTarget(url.search, url.hash);
  state.filter = Object.hasOwn(FILTERS, url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
  state.search = (url.searchParams.get('q') || '').slice(0, 200); $('post-search').value = state.search;
  state.fileSearch = (url.searchParams.get('file') || '').slice(0, 200); $('file-search').value = state.fileSearch;
  if (url.searchParams.get('view') === 'files') { showBoardView('files', { navigate: false }); await loadFiles(); return; }
  await loadQuestions();
  if (epoch !== state.epoch) return;
  if (postId) {
    try {
      const arrived = await refreshQuestion(postId, false, answerId);
      if (epoch !== state.epoch) return;
      if (answerId && !arrived) regionState('board-state', 'error', '답변이 삭제되었거나 이 질문에 없습니다. 질문은 계속 볼 수 있습니다.');
    }
    catch (error) { if (epoch !== state.epoch) return; showBoardView('home', { navigate: false }); regionState('board-state', 'error', error.status === 404 ? '질문이 삭제되었거나 존재하지 않습니다.' : '질문을 불러오지 못했습니다.', () => refreshQuestion(postId)); }
  } else if (url.searchParams.get('view') === 'compose') openQuestionComposer(false);
  else showBoardView('home', { navigate: false });
}
async function loadQuestions({ reset = true, quiet = false } = {}) {
  const epoch = state.epoch, cohort = state.cohort, request = ++questionRequest;
  if (!cohort) return;
  const params = new URLSearchParams({ search: state.search, filter: state.filter });
  if (!reset && state.questionCursor) params.set('before', state.questionCursor);
  if (!quiet) regionState('board-state', 'loading', '질문을 불러오고 있습니다…');
  $('questions-more').disabled = true;
  try {
    const data = await api(`/cohorts/${cohort.id}/questions/page?${params}`);
    if (epoch !== state.epoch || request !== questionRequest) return;
    const items = Array.isArray(data) ? data : data.items;
    state.questions = reset ? items : [...new Map([...state.questions, ...items].map(q => [q.id, q])).values()];
    state.questionTotal = data.total ?? items.length; state.boardStats = data.stats || null;
    state.questionCursor = data.next_before || null;
    $('questions-more').classList.toggle('hidden', !data.has_more);
    $('question-count').textContent = `${state.questionTotal}개 중 ${state.questions.length}개 표시`;
    regionState('board-state'); renderFeed(); renderStats();
  } catch (error) {
    if (epoch === state.epoch && request === questionRequest) regionState('board-state', 'error', errorMessage(error.message), () => loadQuestions({ reset, quiet: false }));
  } finally { if (request === questionRequest) $('questions-more').disabled = false; }
}
async function refreshQuestion(id, quiet = false, answerId = null) {
  const epoch = state.epoch, cohort = state.cohort, current = state.question?.id;
  const question = await api(`/cohorts/${cohort.id}/questions/${id}`);
  if (epoch !== state.epoch || (quiet && state.question?.id !== current)) return;
  return selectQuestion(question, false, { quiet, answerId });
}
async function refreshBoard() {
  if (state.space !== 'board' || !state.cohort) return;
  if (state.boardView === 'files') { await loadFiles({ quiet: true }); return; }
  if (state.boardView === 'compose' || !$('post-edit-form').classList.contains('hidden') || $('post-view').querySelector('.answer-body form')) {
    regionState('board-update', '', '새 변경 사항이 있습니다. 작성 중인 내용을 저장한 뒤 확인하세요.', refreshBoard); return;
  }
  const epoch = state.epoch, id = state.question?.id;
  await loadQuestions({ quiet: true });
  if (epoch !== state.epoch) return;
  if (id && state.question?.id === id) {
    try { await refreshQuestion(id, true); }
    catch (error) { if (error.status === 404) { showBoardView('home'); regionState('board-state', 'error', '열려 있던 질문이 삭제되었습니다.'); } else throw error; }
  }
  regionState('board-update');
}
$('questions-more').addEventListener('click', () => loadQuestions({ reset: false }));
const FILTERS = {
  all: () => true,
  unanswered: q => !q.resolved && Number(q.answer_count) === 0,
  'no-instructor': q => !q.resolved && !q.instructor_answered,
  mine: q => q.username === state.account?.username,
  resolved: q => !!q.resolved,
};
function feedGroup(value) {
  const days = daysAgo(value);
  return days <= 0 ? '오늘' : days === 1 ? '어제' : days < 7 ? '이번 주' : days < 14 ? '지난주' : '이전';
}
function renderFeed() {
  const items = state.questions;
  const list = $('question-list'), nodes = [];
  let group = null;
  for (const q of items) {
    const g = feedGroup(q.created_at);
    if (g !== group) { group = g; nodes.push(el('li', { class: 'feed-group', role: 'presentation', text: g })); }
    const answers = Number(q.answer_count);
    const button = el('button', { class: state.question?.id === q.id ? 'active' : '', 'aria-current': state.question?.id === q.id ? 'true' : null, onclick: () => { closeNav(); selectQuestion(q).catch(error => status(error.message, true)); } },
      el('span', { class: 'feed-title' }, el('span', { text: q.title }), el('time', { datetime: q.created_at, text: feedTime(q.created_at) })),
      el('span', { class: 'feed-snippet', text: plainExcerpt(q.body) }),
      el('span', { class: 'feed-badges' },
        q.resolved ? el('span', { class: 'tag', text: '✓ 해결됨' }) : null,
        q.instructor_answered ? el('span', { class: 'tag instructor', text: '🎓 강사 답변' }) : null,
        q.endorsed ? el('span', { class: 'endorsed-mark', text: '✓ 인정됨' }) : null,
        answers === 0 && !q.resolved ? el('span', { class: 'tag danger', text: '미답변' }) : el('span', { text: `답변 ${answers}` }),
        el('span', { text: `· ${q.display_name || q.username}` })));
    nodes.push(el('li', { class: `feed-item${answers === 0 && !q.resolved ? ' unanswered' : ''}` }, button));
  }
  if (!nodes.length) nodes.push(el('li', { class: 'feed-empty', text: state.search || state.filter !== 'all' ? '조건에 맞는 질문이 없습니다.' : state.cohort?.archived ? '이 수강반에는 질문이 없습니다.' : '아직 질문이 없습니다. 첫 질문을 올려 보세요.' }));
  list.replaceChildren(...nodes);
}
function renderStats() {
  const qs = state.questions;
  const counts = state.boardStats || { total: qs.length, unanswered: qs.filter(FILTERS.unanswered).length, pending: qs.filter(FILTERS['no-instructor']).length, resolved: qs.filter(FILTERS.resolved).length };
  const stat = (value, label, warn = false) => el('div', { class: `stat${warn && value ? ' warn' : ''}` }, el('strong', { text: String(value ?? '–') }), el('span', { text: label }));
  $('board-stats').replaceChildren(
    stat(counts.total, '전체 질문'),
    stat(counts.unanswered, '미답변', true),
    stat(counts.pending, '강사 답변 대기'),
    stat(counts.resolved, '해결됨'));
}
function syncFilterButtons() {
  for (const button of document.querySelectorAll('.filters button')) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  for (const button of document.querySelectorAll('[data-board-filter]')) button.setAttribute('aria-current', String(state.boardView === 'home' && button.dataset.boardFilter === state.filter));
}
function selectBoardFilter(filter) {
  state.filter = filter; showBoardView('home'); closeNav(); syncFilterButtons(); void loadQuestions();
  $('board-heading').focus();
}
for (const button of document.querySelectorAll('.filters button, [data-board-filter]')) {
  button.addEventListener('click', () => selectBoardFilter(button.dataset.filter || button.dataset.boardFilter));
}
let questionSearchTimer;
$('post-search').addEventListener('input', event => { state.search = event.target.value.slice(0, 200); clearTimeout(questionSearchTimer); questionSearchTimer = setTimeout(() => { writeBoardUrl('home', null, true); void loadQuestions(); }, 250); });
$('board-back').addEventListener('click', () => { showBoardView('home'); void loadQuestions(); });
function showBoardView(view, { navigate = true, focus = true } = {}) {
  saveDrafts();
  status('');
  state.boardView = view;
  syncFilterButtons();
  $('board-back').classList.toggle('hidden', view === 'home');
  for (const [name, id] of [['home', 'board-home'], ['post', 'post-view'], ['compose', 'compose-view'], ['files', 'files-view']]) $(id).classList.toggle('hidden', name !== view);
  $('files-link').setAttribute('aria-current', String(view === 'files'));
  if (view !== 'post') {
    state.question = null; state.questionEpoch++;
    $('answer-form').elements.body.value = '';
    renderFeed(); updateControls();
  }
  $('board-heading').textContent = { home: 'Q&A 게시판', post: 'Q&A 게시판', compose: '새 질문', files: '자료실' }[view];
  $('board-space').querySelector('.board-body').scrollTop = 0;
  if (navigate) writeBoardUrl(view);
  if (focus) $('board-heading').focus();
}
async function selectQuestion(question, updateUrl = true, { quiet = false, answerId = null } = {}) {
  const epoch = state.epoch, questionEpoch = ++state.questionEpoch, cohort = state.cohort;
  saveDrafts();
  state.question = question;
  if (!quiet) { state.following = null; $('post-follow').textContent = '알림 설정 불러오는 중'; $('post-follow').disabled = true; }
  void loadQuestionFollow(question.id, questionEpoch);
  $('answer-form').elements.body.value = drafts.get(draftKey('answer', question.id));
  $('answer-draft-status').textContent = $('answer-form').elements.body.value ? '이 탭에 저장한 답변 초안을 불러왔습니다.' : '';
  setDraftPreview('answer', false);
  if (!quiet) showBoardView('post', { navigate: false });
  if (updateUrl) writeBoardUrl('post', question.id);
  $('board-heading').textContent = question.title;
  $('post-title').textContent = question.title;
  $('post-meta').replaceChildren(...[avatar(question.display_name || question.username, question.username, true),
    el('strong', { text: question.display_name || question.username }), roleTag(question.role),
    el('span', { text: `· ${stamp(question.created_at)}` }), el('span', { text: `· 질문 #${question.id}` })].filter(Boolean));
  $('post-body').replaceChildren(...[renderBody(el('span'), question.body), editedMark(question)].filter(Boolean));
  $('post-delete').classList.toggle('hidden', !canDelete(question));
  $('post-resolve').classList.toggle('hidden', !canDelete(question));
  $('post-resolve').textContent = question.resolved ? '해결됨 취소' : '해결됨으로 표시';
  $('post-resolve').setAttribute('aria-pressed', String(!!question.resolved));
  $('post-attachments').classList.toggle('hidden', !question.attachments?.length);
  $('post-attachments').replaceChildren(...(question.attachments || []).map(file => el('li', {}, el('a', { href: fileDownloadUrl(cohort.id, file.id), text: file.name }))));
  $('post-edit').classList.toggle('hidden', !canEdit(question));
  $('post-edit-form').classList.add('hidden'); $('post-content').classList.remove('hidden');
  if (!quiet) { $('instructor-answers').replaceChildren(); $('student-answers').replaceChildren(); }
  renderFeed(); updateControls();
  const answers = await api(`/cohorts/${cohort.id}/questions/${question.id}/answers`);
  if (epoch !== state.epoch || questionEpoch !== state.questionEpoch) return false;
  renderAnswers(answers);
  if (answerId) {
    const target = document.getElementById(`answer-${answerId}`);
    if (!target || !answers.some(answer => answer.id === answerId)) return false;
    target.classList.add('answer-target');
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
    setTimeout(() => target.classList.remove('answer-target'), 3000);
  }
  return true;
}
function renderQuestionFollow() {
  const button = $('post-follow');
  button.textContent = state.following === null ? '알림 설정 다시 불러오기' : state.following ? '팔로우 중 · 해제' : '질문 팔로우';
  button.setAttribute('aria-pressed', String(!!state.following));
  button.setAttribute('aria-label', state.following ? '질문 팔로우 해제' : '이 질문의 새 답변 알림 받기');
  button.disabled = !state.question || !!state.cohort?.archived || !!followMutation;
  button.title = state.cohort?.archived ? '종료된 수강반의 알림 설정은 변경할 수 없습니다.' : '팔로우하면 다른 사람이 답변할 때 내 알림으로 알려드립니다.';
}
async function loadQuestionFollow(id, questionEpoch = state.questionEpoch) {
  const cohort = state.cohort, account = state.account;
  if (followMutation?.questionId === id && followMutation.cohortId === cohort.id) return;
  const request = ++questionFollowRequest;
  try {
    const data = await api(`/cohorts/${cohort.id}/questions/${id}/follow`);
    if (account !== state.account || request !== questionFollowRequest || questionEpoch !== state.questionEpoch || state.question?.id !== id) return;
    state.following = !!data.following; renderQuestionFollow();
  } catch {
    if (account === state.account && request === questionFollowRequest && questionEpoch === state.questionEpoch && state.question?.id === id) { state.following = null; renderQuestionFollow(); }
  }
}
$('post-follow').addEventListener('click', async () => {
  if (!state.question || state.cohort.archived || followMutation) return;
  const question = state.question, cohort = state.cohort, account = state.account;
  $('post-follow').disabled = true;
  if (state.following === null) { await loadQuestionFollow(question.id); return; }
  questionFollowRequest++; followMutation = { questionId: question.id, cohortId: cohort.id };
  try {
    const data = await api(`/cohorts/${cohort.id}/questions/${question.id}/follow`, { method: 'PUT', json: { following: !state.following } });
    if (account === state.account && state.question?.id === question.id && state.cohort?.id === cohort.id) { state.following = data.following; status(data.following ? '이 질문의 새 답변 알림을 받습니다.' : '이 질문의 새 답변 알림을 해제했습니다.'); }
  } catch (error) { if (account === state.account && state.question?.id === question.id) status(error.message, true); }
  finally { followMutation = null; if (account === state.account && state.question) renderQuestionFollow(); }
});
function renderAnswers(answers) {
  const byInstructor = a => a.role === 'instructor' || a.role === 'admin';
  const canEndorse = isManager() && !state.cohort.archived;
  const item = answer => el('li', { id: `answer-${answer.id}`, tabindex: -1, class: answer.endorsed ? 'endorsed' : '' },
    el('div', { class: 'answer-meta' },
      avatar(answer.display_name || answer.username, answer.username, true),
      el('strong', { text: answer.display_name || answer.username }), roleTag(answer.role),
      el('span', { text: stamp(answer.created_at) }),
      answer.endorsed ? el('span', { class: 'endorsed-mark', text: '✓ 강사 인정' }) : null,
      canEndorse && !byInstructor(answer) ? el('button', { class: 'endorse-btn', text: answer.endorsed ? '인정 취소' : '👍 좋은 답변', onclick: event => endorse(answer, event.currentTarget) }) : null,
      canEdit(answer) ? el('button', { class: 'ghost answer-edit', type: 'button', text: '수정', 'aria-label': '내 답변 수정', onclick: event => startEditAnswer(answer, event.currentTarget.closest('li')) }) : null,
      canDelete(answer) ? el('button', { class: 'ghost danger-text answer-delete', type: 'button', text: '삭제', 'aria-label': '답변 삭제', onclick: () => deleteAnswer(answer) }) : null),
    el('div', { class: 'answer-body' }, renderBody(el('span'), answer.body), editedMark(answer)));
  const fill = (id, list, empty) => $(id).replaceChildren(...(list.length ? list.map(item) : [el('li', { class: 'empty-answer', text: empty })]));
  fill('instructor-answers', answers.filter(byInstructor), '아직 강사 답변이 없습니다.');
  fill('student-answers', answers.filter(a => !byInstructor(a)), '아직 수강생 답변이 없습니다. 아는 내용이 있다면 먼저 답해 보세요.');
}
function startEditAnswer(answer, item) {
  const body = item.querySelector('.answer-body');
  if (body.querySelector('form')) return;
  const original = [...body.childNodes];
  const input = el('textarea', { name: 'body', rows: 4, maxlength: 5000, required: true, 'aria-label': '답변 수정' });
  input.value = answer.body;
  const form = el('form', { class: 'inline-edit' }, input,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'ghost', text: '취소', onclick: () => body.replaceChildren(...original) }), el('button', { class: 'primary', text: '저장' })));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const epoch = state.epoch, question = state.question;
    try {
      await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers/${answer.id}`, { method: 'PATCH', json: { body: input.value } });
      if (epoch === state.epoch && state.question?.id === question.id) await refreshQuestion(question.id);
      status('답변을 수정했습니다.');
    } catch (error) { status(error.message, true); }
  });
  body.replaceChildren(form); input.focus();
}
$('post-resolve').addEventListener('click', async () => {
  const question = state.question, cohort = state.cohort, epoch = state.epoch;
  if (!question) return;
  $('post-resolve').disabled = true;
  try {
    await api(`/cohorts/${cohort.id}/questions/${question.id}/resolution`, { method: 'POST', json: { resolved: !question.resolved } });
    if (epoch !== state.epoch) return;
    await loadQuestions();
    if (state.question?.id === question.id) await refreshQuestion(question.id);
  } catch (error) { status(error.message, true); }
  finally { $('post-resolve').disabled = false; }
});
$('post-edit').addEventListener('click', () => {
  const question = state.question, form = $('post-edit-form');
  if (!question) return;
  form.elements.title.value = question.title; form.elements.body.value = question.body;
  $('post-content').classList.add('hidden'); form.classList.remove('hidden'); form.elements.title.focus();
});
$('post-edit-cancel').addEventListener('click', () => { $('post-edit-form').classList.add('hidden'); $('post-content').classList.remove('hidden'); });
handleForm('post-edit-form', async form => {
  const epoch = state.epoch, question = state.question;
  await api(`/cohorts/${state.cohort.id}/questions/${question.id}`, { method: 'PATCH', json: formValues(form) });
  if (epoch !== state.epoch) return;
  await loadQuestions();
  if (state.question?.id === question.id) await refreshQuestion(question.id);
  status('질문을 수정했습니다.');
});
async function deleteAnswer(answer) {
  if (!confirm('이 답변을 삭제할까요?')) return;
  const epoch = state.epoch, question = state.question;
  try {
    await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers/${answer.id}`, { method: 'DELETE' });
    if (epoch !== state.epoch) return;
    await loadQuestions();
    if (epoch === state.epoch && state.question?.id === question.id) await refreshQuestion(question.id);
    status('답변을 삭제했습니다.');
  } catch (error) { status(error.message, true); }
}
$('post-delete').addEventListener('click', async () => {
  const question = state.question;
  if (!question || !confirm('이 질문과 달린 답변을 모두 삭제할까요?')) return;
  const epoch = state.epoch;
  try {
    await api(`/cohorts/${state.cohort.id}/questions/${question.id}`, { method: 'DELETE' });
    if (epoch !== state.epoch) return;
    state.question = null;
    history.replaceState(null, '', location.pathname);
    await loadQuestions();
    showBoardView('home');
    status('질문을 삭제했습니다.');
  } catch (error) { status(error.message, true); }
});
async function endorse(answer, button) {
  const epoch = state.epoch, question = state.question;
  button.disabled = true;
  try {
    await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers/${answer.id}/endorse`, { method: 'POST', json: { endorsed: !answer.endorsed } });
    if (epoch !== state.epoch) return;
    await loadQuestions();
    if (epoch === state.epoch && state.question?.id === question.id) await refreshQuestion(question.id);
  } catch (error) { status(error.message, true); button.disabled = false; }
}
async function loadFiles({ reset = true, quiet = false } = {}) {
  const epoch = state.epoch, cohort = state.cohort, request = ++fileRequest;
  if (!cohort) return;
  const params = new URLSearchParams({ search: state.fileSearch });
  if (!reset && state.fileCursor) params.set('before', state.fileCursor);
  if (!quiet) regionState('files-state', 'loading', '자료를 불러오고 있습니다…');
  $('files-more').disabled = true;
  try {
    const data = await api(`/cohorts/${cohort.id}/files/page?${params}`);
    if (epoch !== state.epoch || request !== fileRequest) return;
    const items = Array.isArray(data) ? data : data.items;
    state.fileItems = reset ? items : [...new Map([...state.fileItems, ...items].map(f => [f.id, f])).values()];
    state.fileCursor = data.next_before || null; state.fileTotal = data.total ?? items.length;
    $('files-more').classList.toggle('hidden', !data.has_more);
    $('file-count').textContent = `${state.fileTotal}개 중 ${state.fileItems.length}개 표시`;
    const list = $('file-list');
    list.replaceChildren(...state.fileItems.map(file => {
      const ext = (file.original_name.split('.').pop() || '').slice(0, 4).toUpperCase();
      const size = file.size_bytes >= 1048576 ? `${(file.size_bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(file.size_bytes / 1024)} KB`;
      return el('li', {}, el('span', { class: 'file-icon', 'aria-hidden': 'true', text: ext }),
        el('div', { class: 'file-info' }, el('a', { href: fileDownloadUrl(cohort.id, file.id), text: file.original_name }),
          el('small', { text: `@${file.username} · ${size} · ${stamp(file.created_at)}` })));
    }));
    regionState('files-state', '', state.fileItems.length ? '' : state.fileSearch ? '검색 조건에 맞는 자료가 없습니다.' : '아직 공유된 자료가 없습니다.');
  } catch (error) {
    if (epoch === state.epoch && request === fileRequest) regionState('files-state', 'error', errorMessage(error.message), () => loadFiles({ reset }));
  } finally { if (request === fileRequest) $('files-more').disabled = false; }
}
$('files-more').addEventListener('click', () => loadFiles({ reset: false }));
let fileSearchTimer;
$('file-search').addEventListener('input', event => { state.fileSearch = event.target.value.slice(0, 200); clearTimeout(fileSearchTimer); fileSearchTimer = setTimeout(() => { writeBoardUrl('files', null, true); void loadFiles(); }, 250); });
const questionDraftKey = () => draftKey('question', 'new');
let uploadedQuestionFiles = new WeakMap(), selectedQuestionFiles = [];
function saveQuestionDraft() {
  const data = formValues($('question-form'));
  drafts.set(questionDraftKey(), data.title || data.body ? JSON.stringify({ title: data.title, body: data.body }) : '');
  $('question-draft-status').textContent = '제목과 내용이 이 탭에 임시 저장됩니다. 첨부파일은 새로고침 후 다시 선택하세요.';
  updateDraftPreview('question');
}
function renderSelectedQuestionFiles() {
  const list = $('question-selected-files');
  list.replaceChildren(...selectedQuestionFiles.map((file, index) => el('li', {},
    el('span', { class: 'selected-file-name', text: file.name }),
    el('span', { class: 'muted small', text: formatFileSize(file.size) }),
    el('button', { type: 'button', class: 'ghost danger-text', 'aria-label': `${file.name} 첨부 제거`, text: '제거', onclick: () => {
      if (pendingForms.has('question-form')) return;
      selectedQuestionFiles.splice(index, 1); renderSelectedQuestionFiles();
    } }))));
}
function updateDraftPreview(kind) {
  const form = $(`${kind}-form`);
  renderBody($(`${kind}-preview-body`), form.elements.body.value || '내용이 없습니다.');
}
function setDraftPreview(kind, preview, focus = true) {
  const form = $(`${kind}-form`), body = form.elements.body;
  body.closest('label').classList.toggle('hidden', preview);
  $(`${kind}-preview-body`).classList.toggle('hidden', !preview);
  $(`${kind}-write`).setAttribute('aria-pressed', String(!preview));
  $(`${kind}-preview`).setAttribute('aria-pressed', String(preview));
  if (preview) updateDraftPreview(kind);
  else if (focus && state.boardView === (kind === 'question' ? 'compose' : 'post')) body.focus();
}
for (const kind of ['question', 'answer']) {
  $(`${kind}-form`).elements.body.addEventListener('invalid', () => setDraftPreview(kind, false), true);
  $(`${kind}-write`).addEventListener('click', () => setDraftPreview(kind, false));
  $(`${kind}-preview`).addEventListener('click', () => setDraftPreview(kind, true));
  $(`${kind}-code`).addEventListener('click', () => {
    setDraftPreview(kind, false);
    const body = $(`${kind}-form`).elements.body;
    const result = insertCodeFence(body.value, body.selectionStart, body.selectionEnd);
    body.value = result.value.slice(0, body.maxLength); body.focus(); body.setSelectionRange(result.start, Math.min(result.end, body.value.length));
    body.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
$('question-form').addEventListener('input', saveQuestionDraft);
$('question-files').addEventListener('change', event => {
  if (pendingForms.has('question-form')) { event.target.value = ''; return; }
  const incoming = [...event.target.files];
  event.target.value = '';
  const next = mergeQuestionFiles(selectedQuestionFiles, incoming);
  const error = questionFileError(next);
  if (error) { $('question-draft-status').textContent = error; return; }
  selectedQuestionFiles = next; renderSelectedQuestionFiles();
  $('question-draft-status').textContent = `${next.length}개 파일을 선택했습니다. 첨부파일은 새로고침 후 다시 선택하세요.`;
});
function openQuestionComposer(navigate = true) {
  closeNav(); showBoardView('compose', { navigate });
  const form = $('question-form');
  try {
    const legacyKey = `madi-question:${state.account?.id}:${state.cohort?.id}`;
    let saved = drafts.get(questionDraftKey());
    if (!saved) { saved = tabStorage?.getItem(legacyKey) || ''; if (saved) drafts.set(questionDraftKey(), saved); }
    if (saved) tabStorage?.removeItem(legacyKey);
    const draft = JSON.parse(saved || 'null');
    if (draft && !form.elements.title.value && !form.elements.body.value) { form.elements.title.value = draft.title || ''; form.elements.body.value = draft.body || ''; $('question-draft-status').textContent = '이 탭에 저장한 질문을 불러왔습니다.'; }
  } catch { /* storage unavailable */ }
  setDraftPreview('question', false);
  form.elements.title.focus();
}
$('new-post-btn').addEventListener('click', () => openQuestionComposer());
$('compose-cancel').addEventListener('click', () => showBoardView('home'));
$('question-discard').addEventListener('click', () => {
  if (pendingForms.has('question-form')) return;
  drafts.set(questionDraftKey(), ''); $('question-form').reset();
  selectedQuestionFiles = []; uploadedQuestionFiles = new WeakMap(); renderSelectedQuestionFiles();
  $('question-draft-status').textContent = '질문 초안을 버렸습니다.';
  setDraftPreview('question', false); $('question-form').elements.title.focus();
});
$('answer-discard').addEventListener('click', () => {
  if (pendingForms.has('answer-form') || !state.question) return;
  drafts.set(draftKey('answer', state.question.id), ''); $('answer-form').elements.body.value = '';
  $('answer-draft-status').textContent = '답변 초안을 버렸습니다.';
  setDraftPreview('answer', false);
});
$('files-link').addEventListener('click', () => { closeNav(); showBoardView('files'); void loadFiles(); });

/* ---------- forms ---------- */
function handleForm(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    if (pendingForms.has(id)) return;
    const form = event.currentTarget, account = state.account;
    const button = form.querySelector('button[type=submit], button:not([type])');
    pendingForms.add(id); form.setAttribute('aria-busy', 'true'); status('', false, form);
    if (button) button.disabled = true;
    const epoch = state.epoch;
    try {
      await action(form);
      if (!['message-form', 'answer-form', 'question-form', 'roster-form'].includes(id) && (epoch === state.epoch || id === 'login-form')) form.reset();
    } catch (error) {
      if (id === 'first-login-form') regionState('first-login-status', 'error', error.message);
      else if (account === state.account || id === 'login-form') {
        status(error.message, true, form);
        if (id === 'question-form') $('question-draft-status').textContent = '등록에 실패했습니다. 제목·내용과 선택한 파일은 남아 있습니다. 다시 시도할 수 있습니다.';
        if (id === 'answer-form') $('answer-draft-status').textContent = '등록에 실패했습니다. 답변 초안은 남아 있습니다. 다시 시도할 수 있습니다.';
      }
    }
    finally { pendingForms.delete(id); form.removeAttribute('aria-busy'); if (button) button.disabled = false; updateControls(); }
  });
}

handleForm('login-form', async form => {
  await api('/login', { method: 'POST', json: formValues(form) });
  state.account = await api('/me');
  status(''); $('login-message').classList.add('hidden');
  showAccount();
  if (state.account.must_change_password) { $('first-login-form').elements.current_password.value = form.elements.password.value; $('first-login-form').elements.new_password.focus(); return; }
  void loadMediaAvailability();
  await loadCohorts();
});

handleForm('first-login-form', async form => {
  if (form.elements.new_password.value !== form.elements.confirm_password.value) throw new Error('새 비밀번호와 확인 값이 일치하지 않습니다.');
  await api('/me/password', { method: 'POST', json: { current_password: form.elements.current_password.value, new_password: form.elements.new_password.value } });
  state.account = await api('/me');
  form.reset(); regionState('first-login-status'); showAccount();
  void loadMediaAvailability(); await loadCohorts();
});
$('first-login-logout').addEventListener('click', () => $('logout-btn').click());

$('logout-btn').addEventListener('click', async () => {
  saveDrafts(); closeChat();
  try { await api('/logout', { method: 'POST' }); } catch (error) { status(error.message, true); return; }
  state.cohort = null; resetContent();
  state.account = null; state.cohorts = []; state.accounts = []; state.mediaAvailable = null;
  for (const id of FORM_IDS) $(id).reset();
  uploadedQuestionFiles = new WeakMap(); $('question-draft-status').textContent = '';
  $('account-list').replaceChildren(); $('membership-options').replaceChildren();
  showAccount(); showSpace();
  $('login-message').classList.add('hidden');
  status('로그아웃되었습니다.');
});

handleForm('message-form', async () => {
  if (!state.cohort || !state.channel) throw new Error('먼저 채널을 선택하세요');
  const cohort = state.cohort, channel = state.channel, account = state.account, channelEpoch = state.channelEpoch;
  const original = $('message-input').value, body = original.trim(), key = draftKey('message', channel.id);
  if (!body) return;
  drafts.set(key, original);
  const message = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages`, { method: 'POST', json: { body } });
  drafts.clearIfUnchanged(key, original);
  if (account === state.account && channelEpoch === state.channelEpoch) {
    if ($('message-input').value === original) $('message-input').value = drafts.get(key);
    if (!$('message-input').value) $('message-input').style.height = '';
    receive(message);
  }
});

handleForm('question-form', async form => {
  if (!state.cohort) throw new Error('수강반을 선택하세요.');
  const epoch = state.epoch, cohort = state.cohort, key = questionDraftKey();
  const data = formValues(form), files = [...selectedQuestionFiles];
  const fileError = questionFileError(files);
  if (fileError) throw new Error(fileError);
  drafts.set(key, JSON.stringify({ title: data.title, body: data.body }));
  const attachments = [];
  for (const [index, file] of files.entries()) {
    $('question-draft-status').textContent = `첨부파일 ${index + 1}/${files.length} 처리 중: ${file.name}`;
    let id = uploadedQuestionFiles.get(file);
    if (!id) {
      const payload = new FormData(); payload.append('upload', file);
      const result = await uploadFile(cohort.id, payload);
      id = result.id; uploadedQuestionFiles.set(file, id);
    }
    attachments.push(id);
    if (epoch !== state.epoch) return;
  }
  $('question-draft-status').textContent = '질문 등록 중…';
  const { id } = await api(`/cohorts/${cohort.id}/questions`, { method: 'POST', json: { ...data, attachments } });
  if (epoch !== state.epoch) return;
  if (form.elements.title.value === data.title && form.elements.body.value === data.body) {
    form.reset(); drafts.clearIfUnchanged(key, JSON.stringify({ title: data.title, body: data.body }));
    selectedQuestionFiles = []; uploadedQuestionFiles = new WeakMap(); renderSelectedQuestionFiles();
    $('question-draft-status').textContent = '';
  } else {
    $('question-draft-status').textContent = '질문이 등록되었습니다. 새로 입력한 내용은 초안으로 남았습니다.';
  }
  await loadQuestions();
  const created = await api(`/cohorts/${cohort.id}/questions/${id}`);
  if (epoch === state.epoch) await selectQuestion(created);
  status('질문을 등록했습니다.');
});

handleForm('answer-form', async form => {
  if (!state.question) throw new Error('질문을 선택하세요');
  const epoch = state.epoch, cohort = state.cohort, question = state.question, key = draftKey('answer', question.id);
  const original = form.elements.body.value, data = formValues(form);
  drafts.set(key, original);
  $('answer-draft-status').textContent = '답변 등록 중…';
  await api(`/cohorts/${cohort.id}/questions/${question.id}/answers`, { method: 'POST', json: data });
  drafts.clearIfUnchanged(key, original);
  if (epoch !== state.epoch) return;
  if (state.question?.id === question.id && form.elements.body.value === original) {
    form.elements.body.value = drafts.get(key);
    $('answer-draft-status').textContent = form.elements.body.value ? '새로 입력한 내용은 초안으로 남았습니다.' : '';
  }
  await loadQuestions();
  if (epoch === state.epoch && state.question?.id === question.id) await refreshQuestion(question.id);
});

handleForm('file-form', async form => {
  const epoch = state.epoch;
  await uploadFile(state.cohort.id, form);
  if (epoch === state.epoch) await loadFiles();
  status('파일을 올렸습니다.');
});

handleForm('account-form', async form => {
  const data = formValues(form), cohort = state.cohort;
  const enroll = $('enroll-new-account').checked && !!cohort && !cohort.archived;
  const role = $('new-account-role').value;
  await api('/accounts', { method: 'POST', json: data });
  await loadAccounts();
  if (enroll) {
    try {
      await api(`/cohorts/${cohort.id}/memberships`, { method: 'POST', json: { username: data.username, role } });
      await refreshManagement();
      if (state.cohort === cohort && state.space === 'chat') await loadMembers();
      status('계정을 만들고 수강반에 추가했습니다.');
    } catch { status('계정은 생성되었습니다. 수강반 추가에 실패했으니 수강반 관리에서 다시 추가해 주세요.', true); }
  } else status('계정을 만들었습니다. 수강반 관리에서 구성원으로 추가할 수 있습니다.');
});

handleForm('cohort-form', async form => {
  const cohort = await api('/cohorts', { method: 'POST', json: formValues(form) });
  await loadCohorts(cohort.id);
  await refreshCohortChecklist();
  status('수강반을 만들었습니다. 구성원과 채널을 추가해 주세요.');
});

handleForm('membership-form', async form => {
  await api(`/cohorts/${state.cohort.id}/memberships`, { method: 'POST', json: formValues(form) });
  if (state.space === 'chat') await loadMembers();
  await refreshManagement();
  status('구성원 정보를 저장했습니다.');
});

handleForm('channel-form', async form => {
  await api(`/cohorts/${state.cohort.id}/channels`, { method: 'POST', json: formValues(form) });
  if (state.space === 'chat') await loadChannels();
  $('management').close();
  status('채널을 만들었습니다.');
});

async function refreshManagement() {
  const cohort = state.cohort, admin = !!state.account?.is_admin;
  if (cohort && admin) {
    $('cohort-status-text').textContent = `${cohort.name} — ${cohort.archived ? '종료됨 (읽기 전용)' : '진행 중'}`;
    $('archive-btn').textContent = cohort.archived ? '수강반 다시 열기' : '수강반 종료';
    $('archive-btn').className = cohort.archived ? '' : 'danger';
  }
  const jobs = [];
  if (admin) jobs.push(loadAccounts());
  if (cohort && isManager()) jobs.push(loadManageMembers());
  await Promise.all(jobs);
}
async function loadManageMembers() {
  const cohort = state.cohort, admin = !!state.account?.is_admin;
  const members = await api(`/cohorts/${cohort.id}/members`);
  if (state.cohort !== cohort) return;
  state.manageMembers = members; renderManageMembers();
}
function renderManageMembers() {
  if (!state.cohort) return;
  const cohort = state.cohort, admin = !!state.account?.is_admin, term = $('member-search').value.trim().toLowerCase();
  const members = (state.manageMembers || []).filter(m => `${m.username} ${m.display_name}`.toLowerCase().includes(term));
  const rows = members.map(member => {
    const removable = member.username !== state.account.username && (admin || member.role === 'student') && !cohort.archived;
    return el('li', {},
      el('span', { class: 'who', text: `${member.display_name} (@${member.username})` }), roleTag(member.role),
      removable ? el('button', { class: 'ghost danger-text', type: 'button', text: '내보내기', 'aria-label': `${member.display_name} 내보내기`,
        onclick: () => removeMember(member) }) : null);
  });
  $('manage-members').replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted', text: '구성원이 없습니다.' })]));
}
async function removeMember(member) {
  if (!confirm(`${member.display_name}(@${member.username})님을 이 수강반에서 내보낼까요? 작성한 글은 남고, 채팅 연결은 바로 끊깁니다.`)) return;
  try {
    await api(`/cohorts/${state.cohort.id}/memberships/${member.id}`, { method: 'DELETE' });
    await loadManageMembers();
    if (state.space === 'chat') await loadMembers();
    status('구성원을 내보냈습니다.');
  } catch (error) { status(error.message, true); }
}
async function loadAccounts() {
  const account = state.account;
  const accounts = await api('/accounts');
  if (state.account !== account) return;
  state.accounts = accounts;
  $('membership-options').replaceChildren(...accounts.filter(a => a.active).map(a => el('option', { value: a.username, label: a.display_name })));
  renderAccounts();
}
function renderAccounts() {
  const term = $('account-search').value.trim().toLowerCase();
  const accounts = state.accounts.filter(a => `${a.username} ${a.display_name}`.toLowerCase().includes(term));
  const cohortName = new Map(state.cohorts.map(c => [c.id, c.name]));
  $('account-list').replaceChildren(...accounts.map(account => {
    const self = account.id === state.account.id;
    const where = account.is_admin ? '관리자' : account.memberships.map(m => `${cohortName.get(m.cohort_id) || `#${m.cohort_id}`} ${ROLE_LABEL[m.role] || m.role}`).join(', ') || '소속 없음';
    return el('li', { class: account.active ? '' : 'inactive' },
      el('span', { class: 'who', text: `${account.display_name} (@${account.username}) · ${where}`, title: where }),
      account.must_change_password ? el('span', { class: 'tag', text: '첫 로그인 대기', title: '임시 비밀번호를 변경하면 수업에 참여할 수 있습니다.' }) : null,
      account.active ? null : el('span', { class: 'tag danger', text: '비활성' }),
      self ? null : el('button', { class: 'ghost', type: 'button', text: '비밀번호 재설정', onclick: () => resetPassword(account) }),
      self ? null : el('button', { class: account.active ? 'ghost danger-text' : 'ghost', type: 'button', text: account.active ? '비활성화' : '활성화',
        onclick: () => setAccountActive(account, !account.active) }));
  }));
}
async function resetPassword(account) {
  if (!confirm(`@${account.username}의 비밀번호를 임시 비밀번호로 바꿀까요? 이 계정의 모든 로그인이 끊깁니다.`)) return;
  try {
    const result = await api(`/accounts/${account.id}/password`, { method: 'POST' });
    const notice = $('temp-password');
    notice.textContent = `@${result.username}의 임시 비밀번호: ${result.temporary_password} — 지금만 표시됩니다. 전달 후 본인이 변경하도록 안내하세요.`;
    notice.classList.remove('hidden');
  } catch (error) { status(error.message, true); }
}
async function setAccountActive(account, active) {
  const question = active ? `@${account.username} 계정을 다시 활성화할까요?`
    : `@${account.username} 계정을 비활성화할까요? 로그인이 바로 끊기고 다시 로그인할 수 없습니다.`;
  if (!confirm(question)) return;
  try {
    await api(`/accounts/${account.id}`, { method: 'PATCH', json: { active } });
    await loadAccounts();
    status(active ? '계정을 활성화했습니다.' : '계정을 비활성화했습니다.');
  } catch (error) { status(error.message, true); }
}
$('archive-btn').addEventListener('click', async () => {
  const cohort = state.cohort;
  if (!cohort) return;
  const archive = !cohort.archived;
  if (!confirm(archive ? `${cohort.name}을(를) 종료할까요? 기존 내용은 읽을 수 있지만 새 글과 채팅은 막힙니다.` : `${cohort.name}을(를) 다시 열까요?`)) return;
  try {
    await api(`/cohorts/${cohort.id}`, { method: 'PATCH', json: { archived: archive } });
    await loadCohorts(cohort.id);
    await refreshManagement();
    status(archive ? '수강반을 종료했습니다.' : '수강반을 다시 열었습니다.');
  } catch (error) { status(error.message, true); }
});
handleForm('password-form', async () => {
  const form = $('password-form');
  await api('/me/password', { method: 'POST', json: formValues(form) });
  status('비밀번호를 변경했습니다. 다른 기기의 로그인은 끊겼습니다.');
});
function setManagementTab(tab) {
  const admin = !!state.account?.is_admin, manager = !!state.cohort && isManager();
  if ((tab === 'academy' && !admin) || (tab === 'class' && !manager)) tab = 'personal';
  state.managementTab = tab;
  syncRosterCohorts();
  $('management-cohort').textContent = state.cohort ? `관리 중인 수강반: ${state.cohort.name}` : '';
  $('self-card').classList.toggle('hidden', tab !== 'personal');
  $('admin-card').classList.toggle('hidden', tab !== 'academy' || !admin);
  $('accounts-card').classList.toggle('hidden', tab !== 'academy' || !admin || state.academyTask !== 'accounts');
  $('manage-card').classList.toggle('hidden', tab !== 'class' || !manager);
  for (const button of document.querySelectorAll('[data-management-tab]')) {
    const name = button.dataset.managementTab;
    button.classList.toggle('hidden', (name === 'academy' && !admin) || (name === 'class' && !manager));
    button.setAttribute('aria-pressed', String(name === tab));
  }
  $('enroll-new-account').disabled = !state.cohort || !!state.cohort.archived;
  $('new-account-role-label').classList.toggle('hidden', !$('enroll-new-account').checked || $('enroll-new-account').disabled);
  setAcademyTask(state.academyTask);
}
function setAcademyTask(task, focus = false) {
  if (!['accounts', 'cohorts', 'roster'].includes(task)) task = 'accounts';
  state.academyTask = task;
  const visible = state.managementTab === 'academy' && !!state.account?.is_admin;
  $('academy-task-nav').classList.toggle('hidden', !visible);
  $('academy-task-title').classList.toggle('hidden', !visible);
  $('academy-task-title').textContent = { accounts: '계정 관리', cohorts: '수강반 만들기', roster: '명단 가져오기' }[task];
  $('account-form').classList.toggle('hidden', !visible || task !== 'accounts');
  $('cohort-form').classList.toggle('hidden', !visible || task !== 'cohorts');
  $('cohort-checklist').classList.toggle('hidden', !visible || task !== 'cohorts');
  $('roster-card').classList.toggle('hidden', !visible || task !== 'roster');
  $('accounts-card').classList.toggle('hidden', !visible || task !== 'accounts');
  for (const button of document.querySelectorAll('[data-academy-task]')) button.setAttribute('aria-pressed', String(button.dataset.academyTask === task));
  if (focus && visible) {
    $('academy-task-title').focus(); document.querySelector('.management-body').scrollTop = 0;
    if (task === 'cohorts') void refreshCohortChecklist();
  }
}
let checklistRequest = 0;
async function refreshCohortChecklist() {
  const cohort = state.cohort, request = ++checklistRequest;
  const list = $('cohort-checklist-items');
  $('cohort-checklist-target').textContent = cohort ? `${cohort.name} · ${cohort.archived ? '종료됨' : '진행 중'}` : '수강반을 만들거나 선택하면 준비 상태를 확인할 수 있습니다.';
  if (!cohort) { list.replaceChildren(); return; }
  list.replaceChildren(el('li', { class: 'muted', text: '저장된 설정을 확인하는 중…' }));
  try {
    const [channels, members] = await Promise.all([
      api(`/cohorts/${cohort.id}/channels`), api(`/cohorts/${cohort.id}/members`),
    ]);
    if (request !== checklistRequest || state.cohort !== cohort) return;
    const items = [
      { done: channels.length > 0, text: `채널 ${channels.length}개`, action: '채널 만들기', run: () => { setManagementTab('class'); $('channel-form').elements.slug.focus(); } },
      { done: members.some(member => member.role === 'instructor'), text: `강사 ${members.filter(member => member.role === 'instructor').length}명`, action: '강사 추가', run: () => { setManagementTab('class'); $('membership-form').elements.role.value = 'instructor'; $('membership-form').elements.username.focus(); } },
      { done: members.some(member => member.role === 'student'), text: `수강생 ${members.filter(member => member.role === 'student').length}명`, action: '명단 가져오기', run: () => { setAcademyTask('roster', true); $('roster-source').focus(); } },
    ];
    list.replaceChildren(...items.map(item => el('li', {}, el('span', { text: `${item.done ? '✓' : '○'} ${item.text}` }),
      item.done || cohort.archived ? null : el('button', { type: 'button', class: 'ghost', text: item.action, onclick: item.run }))));
  } catch (error) {
    if (request === checklistRequest && state.cohort === cohort) list.replaceChildren(el('li', { class: 'muted', text: '준비 상태를 불러오지 못했습니다.' }),
      el('li', {}, el('button', { type: 'button', text: '다시 시도', onclick: () => void refreshCohortChecklist() })));
  }
}
async function openManagement(tab = 'personal', academyTask = 'accounts') {
  status(''); closeNav();
  $('temp-password').classList.add('hidden'); $('temp-password').textContent = '';
  if (tab === 'academy') state.academyTask = academyTask;
  setManagementTab(tab);
  $('management').showModal();
  try { await refreshManagement(); if (tab === 'academy' && state.academyTask === 'cohorts') await refreshCohortChecklist(); } catch (error) { status(error.message, true); }
}
for (const button of document.querySelectorAll('[data-management-tab]')) button.addEventListener('click', () => setManagementTab(button.dataset.managementTab));
for (const button of document.querySelectorAll('[data-academy-task]')) button.addEventListener('click', () => { if (!rosterApplying) setAcademyTask(button.dataset.academyTask, true); });
$('enroll-new-account').addEventListener('change', () => setManagementTab(state.managementTab));
$('account-form').addEventListener('reset', () => queueMicrotask(() => setManagementTab(state.managementTab)));
$('account-search').addEventListener('input', renderAccounts);
$('member-search').addEventListener('input', renderManageMembers);
let candidateTimer, candidateRequest = 0;
$('membership-form').elements.username.addEventListener('input', event => {
  const search = event.target.value.trim(), cohort = state.cohort, request = ++candidateRequest;
  clearTimeout(candidateTimer);
  if (!search || !cohort) { $('membership-options').replaceChildren(); return; }
  candidateTimer = setTimeout(async () => {
    try {
      const items = await api(`/cohorts/${cohort.id}/members/candidates?q=${encodeURIComponent(search)}`);
      if (request === candidateRequest && cohort === state.cohort) $('membership-options').replaceChildren(...items.map(a => el('option', { value: a.username, label: a.display_name })));
    } catch (error) { if (request === candidateRequest) status(error.message, true); }
  }, 250);
});
$('manage-btn').addEventListener('click', () => openManagement('personal'));
$('class-manage-btn').addEventListener('click', () => openManagement('class'));
$('academy-manage-btn').addEventListener('click', () => openManagement('academy', state.academyTask));
$('add-channel-btn').addEventListener('click', async () => { await openManagement('class'); $('channel-form').elements.slug.focus(); });
$('management-close').addEventListener('click', () => $('management').close());
$('management').addEventListener('close', () => { $('temp-password').classList.add('hidden'); $('temp-password').textContent = ''; clearRosterCredentials(); });

/* ---------- academy roster onboarding ---------- */
let rosterPlan = null, rosterCredentials = [], rosterApplying = false;
function clearRosterCredentials() {
  rosterCredentials = []; $('roster-credentials').value = ''; $('roster-result').classList.add('hidden');
}
function invalidateRoster() {
  rosterPlan = null; $('roster-preview').replaceChildren(); $('roster-preview').classList.add('hidden'); $('roster-apply').classList.add('hidden');
  $('roster-stage').textContent = '1. 대상 수강반과 명단 입력';
}
function syncRosterCohorts() {
  const select = $('roster-cohort'), previous = select.value;
  select.replaceChildren(el('option', { value: '', text: '수강반 선택' }), ...state.cohorts.filter(c => !c.archived).map(c => el('option', { value: c.id, text: c.name })));
  select.value = [...select.options].some(o => o.value === previous) && previous ? previous : state.cohort && !state.cohort.archived ? String(state.cohort.id) : '';
  if (select.value !== previous) invalidateRoster();
  $('roster-target').textContent = select.selectedOptions[0]?.value ? `대상 수강반: ${select.selectedOptions[0].textContent}` : '대상 수강반을 선택하세요.';
  $('roster-preview-btn').disabled = !state.account?.is_admin || !select.value;
}
$('roster-form').addEventListener('input', invalidateRoster);
$('roster-cohort').addEventListener('change', () => { invalidateRoster(); $('roster-preview-btn').disabled = !$('roster-cohort').value; $('roster-target').textContent = $('roster-cohort').selectedOptions[0]?.value ? `대상 수강반: ${$('roster-cohort').selectedOptions[0].textContent}` : '대상 수강반을 선택하세요.'; });
$('roster-file').addEventListener('change', async event => {
  invalidateRoster(); const file = event.target.files[0];
  if (!file) return;
  try { if (file.size > 100000) throw new Error('명단 파일은 100KB 이하로 선택해 주세요.'); $('roster-source').value = await file.text(); }
  catch (error) { status(error.message, true); }
});
handleForm('roster-form', async () => {
  const source = $('roster-source').value, cohortId = $('roster-cohort').value, account = state.account;
  invalidateRoster();
  const rows = parseRoster(source), plan = await api('/accounts/import/preview', { method: 'POST', json: { cohort_id: Number(cohortId), rows } });
  if (account !== state.account || $('roster-source').value !== source || $('roster-cohort').value !== cohortId) return;
  rosterPlan = { ...plan, input: rows, source };
  $('roster-stage').textContent = `2. ${plan.cohort.name} 명단 검토`;
  $('roster-target').textContent = `대상 수강반: ${plan.cohort.name}`;
  const action = { create: '신규 생성·배정', enroll: '기존 계정 배정', unchanged: '이미 배정됨' };
  const body = el('tbody');
  const shown = el('p', { class: 'muted small', role: 'status' });
  const errorsOnly = el('input', { type: 'checkbox', id: 'roster-errors-only', disabled: !plan.invalid_rows });
  const renderRows = () => {
    const rows = errorsOnly.checked ? plan.rows.filter(row => row.errors.length) : plan.rows;
    body.replaceChildren(...rows.map(row => el('tr', { class: row.errors.length ? 'roster-error' : '' },
      ...[row.row, row.username, row.display_name, ROLE_LABEL[row.role] || row.role,
        row.errors.length ? row.errors.join(' ') : action[row.action]].map(text => el('td', { text: String(text) })))));
    shown.textContent = `${rows.length} / ${plan.total_rows}행 표시`;
  };
  errorsOnly.addEventListener('change', renderRows);
  renderRows();
  $('roster-preview').replaceChildren(
    el('p', { text: rosterPreviewSummary(plan) }),
    el('p', { class: plan.valid ? '' : 'notice', text: plan.valid
      ? '아래 내용을 확인하고 적용하세요. 기존 계정의 표시 이름과 비밀번호는 바꾸지 않습니다.'
      : `오류 ${plan.invalid_rows}행이 있어 전체 명단을 적용할 수 없습니다. 오류를 모두 수정한 뒤 다시 미리 확인하세요.` }),
    el('label', { class: 'check-label' }, errorsOnly, '오류 행만 보기'), shown,
    el('p', { class: 'muted small', text: '행 번호는 제목·빈 행을 제외한 데이터 순서입니다. 따옴표 안의 줄바꿈은 같은 데이터 행입니다. 표는 좌우로 움직여 확인할 수 있습니다.' }),
    el('div', { class: 'roster-table-wrap', tabindex: '0', role: 'region', 'aria-label': '명단 미리보기' },
      el('table', {}, el('thead', {}, el('tr', {}, ...['데이터 행', '아이디', '이름', '역할', '처리'].map(text => el('th', { scope: 'col', text })))), body)));
  $('roster-preview').classList.remove('hidden'); $('roster-apply').classList.toggle('hidden', !plan.valid);
});
$('roster-apply').addEventListener('click', async () => {
  if (!rosterPlan?.valid || rosterApplying) return;
  const plan = rosterPlan, account = state.account;
  rosterApplying = true; status(''); clearRosterCredentials();
  const controls = [...$('roster-form').elements, $('roster-apply'), $('management-close'), ...document.querySelectorAll('[data-management-tab], [data-academy-task]')];
  controls.forEach(c => { c.disabled = true; }); $('roster-card').setAttribute('aria-busy', 'true');
  try {
    const result = await api('/accounts/import', { method: 'POST', json: { cohort_id: plan.cohort.id, rows: plan.input, revision: plan.revision } });
    if (account !== state.account) return;
    invalidateRoster(); rosterCredentials = result.credentials;
    $('roster-result-summary').textContent = `${result.cohort.name} · 신규 ${result.counts.create}명, 기존 계정 배정 ${result.counts.enroll}명, 이미 배정 ${result.counts.unchanged}명`;
    $('roster-stage').textContent = `3. ${result.cohort.name} 로그인 정보 배포`;
    $('roster-target').textContent = `대상 수강반: ${result.cohort.name}`;
    $('roster-credentials').value = result.credentials.length ? credentialsCsv(result.credentials, { spreadsheetSafe: false }).replace(/^\uFEFF/, '') : '';
    for (const id of ['roster-credentials-notice', 'roster-credentials-label', 'roster-download', 'roster-clear']) $(id).classList.toggle('hidden', !result.credentials.length);
    $('roster-result').classList.remove('hidden'); $('roster-result-title').setAttribute('tabindex', '-1'); $('roster-result-title').focus();
    try { await refreshManagement(); if (state.space === 'chat' && state.cohort) await loadMembers(); }
    catch { status('명단 적용은 완료했습니다. 관리 목록을 다시 열어 확인해 주세요.', true); }
  } catch (error) { invalidateRoster(); status(error.message, true); }
  finally { rosterApplying = false; controls.forEach(c => { c.disabled = false; }); $('roster-card').removeAttribute('aria-busy'); }
});
$('management').addEventListener('cancel', event => { if (rosterApplying) event.preventDefault(); });
$('roster-clear').addEventListener('click', clearRosterCredentials);
$('roster-download').addEventListener('click', () => {
  if (!rosterCredentials.length) return;
  const url = URL.createObjectURL(new Blob([credentialsCsv(rosterCredentials)], { type: 'text/csv;charset=utf-8' }));
  const link = el('a', { href: url, download: 'madi-new-accounts.csv' }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------- personal notification inbox ---------- */
function renderNotificationBadge() {
  $('notifications-count').textContent = inbox.unread > 99 ? '99+' : String(inbox.unread);
  $('notifications-count').classList.toggle('hidden', !inbox.unread);
  $('notifications-btn').setAttribute('aria-label', `내 알림${inbox.unread ? `, 안 읽은 알림 ${inbox.unread}개` : ''}`);
  document.querySelectorAll('.menu-btn').forEach(button => {
    button.classList.toggle('has-notifications', inbox.unread > 0);
    button.setAttribute('aria-label', inbox.unread ? `메뉴 열기, 안 읽은 알림 ${inbox.unread}개` : '메뉴 열기');
  });
}
function syncNotificationSession() {
  const owner = state.account && !state.account.must_change_password ? state.account.id : null;
  if (inbox.owner === owner) return;
  clearInterval(notificationPoll); clearTimeout(notificationDebounce); notificationRequest++;
  Object.assign(inbox, { owner, items: [], cursor: null, unread: 0, total: 0, loading: false, more: false });
  $('notifications-list').replaceChildren(); $('notifications-total').textContent = ''; renderNotificationBadge();
  if (!owner) { $('notifications-dialog').close(); return; }
  void refreshNotificationCount();
  notificationPoll = setInterval(() => { if (document.visibilityState === 'visible') void refreshNotificationCount(); }, 30000);
}
async function refreshNotificationCount(quiet = false) {
  const account = state.account;
  if (!inbox.owner || !account || account.must_change_password) return;
  try {
    const data = await api('/notifications/unread');
    if (account !== state.account) return;
    const count = Number(data.unread_total || 0);
    if (!quiet && $('notifications-dialog').open && count !== inbox.unread) regionState('notifications-update', '', '알림 목록이 변경되었습니다. 새 목록을 확인하세요.', () => loadNotifications());
    inbox.unread = count; renderNotificationBadge(); $('notifications-btn').title = '내 알림';
  } catch {
    if (account === state.account) $('notifications-btn').title = '알림을 갱신하지 못했습니다. 열어서 다시 시도하세요.';
  }
}
function queueNotificationRefresh() {
  clearTimeout(notificationDebounce);
  notificationDebounce = setTimeout(() => void refreshNotificationCount(), 250);
}
addEventListener('focus', queueNotificationRefresh);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') queueNotificationRefresh(); });
function renderNotifications() {
  const list = $('notifications-list');
  list.replaceChildren(...inbox.items.map(item => {
    const text = item.kind === 'answer' ? `${item.actor_name}님이 답변했습니다` : `${item.actor_name}님이 나를 멘션했습니다`;
    const target = item.kind === 'answer' ? item.question_title : item.channel_kind === 'dm' ? '다이렉트 메시지' : `# ${item.channel_name}`;
    const link = el('a', { class: 'notification-link', href: notificationUrl(item), onclick: event => {
      if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); const currentLink = event.currentTarget;
      if (currentLink.getAttribute('aria-busy') === 'true') return;
      currentLink.setAttribute('aria-busy', 'true');
      void openNotification(item).catch(error => { status(error.message, true); if ($('notifications-dialog').open) void loadNotifications(); }).finally(() => currentLink.removeAttribute('aria-busy'));
    } }, el('strong', { text }), el('span', { class: 'notification-target', text: target }),
      el('span', { class: 'notification-excerpt', text: plainExcerpt(item.excerpt) }), el('small', { text: `${item.cohort_name} · ${stamp(item.created_at)}` }));
    const readButton = el('button', { class: 'ghost notification-read', type: 'button', text: item.read_at ? '안 읽음으로' : '읽음으로', onclick: async () => {
      readButton.disabled = true; const account = state.account;
      try {
        await api(`/notifications/${item.id}/read`, { method: 'POST', json: { read: !item.read_at } });
        if (account !== state.account) return;
        item.read_at = item.read_at ? null : new Date().toISOString();
        if ($('notifications-unread').checked && item.read_at) { inbox.items = inbox.items.filter(n => n.id !== item.id); inbox.total--; }
        renderNotifications(); await refreshNotificationCount(true); regionState('notifications-update');
      } catch (error) { status(error.message, true); readButton.disabled = false; }
    } });
    return el('li', { class: item.read_at ? 'notification read' : 'notification unread', dataset: { notificationId: item.id } }, link, readButton);
  }));
  if (!inbox.items.length) list.append(el('li', { class: 'notification-empty muted', text: $('notifications-unread').checked ? '안 읽은 알림이 없습니다.' : '아직 알림이 없습니다. 질문을 팔로우하면 새 답변을 여기에서 확인할 수 있습니다.' }));
  $('notifications-total').textContent = `${inbox.total}개 중 ${inbox.items.length}개 표시`;
  $('notifications-more').classList.toggle('hidden', !inbox.more);
  $('notifications-read-all').disabled = !inbox.items.some(n => !n.read_at);
}
async function loadNotifications(reset = true) {
  if (!inbox.owner || (inbox.loading && !reset)) return;
  inbox.loading = true; const request = ++notificationRequest, account = state.account;
  const params = new URLSearchParams({ unread_only: $('notifications-unread').checked });
  if (!reset && inbox.cursor) params.set('before', inbox.cursor);
  regionState('notifications-state', 'loading', '알림을 불러오고 있습니다…');
  $('notifications-more').disabled = true; $('notifications-unread').disabled = true;
  try {
    const data = await api(`/notifications?${params}`);
    if (account !== state.account || request !== notificationRequest) return;
    const rows = data.items || [];
    inbox.items = reset ? rows : [...new Map([...inbox.items, ...rows].map(n => [n.id, n])).values()];
    inbox.cursor = data.next_before; inbox.total = Number(data.total || 0); inbox.unread = Number(data.unread_total || 0); inbox.more = !!data.has_more;
    regionState('notifications-state'); regionState('notifications-update'); renderNotifications(); renderNotificationBadge();
  } catch (error) { if (account === state.account && request === notificationRequest) regionState('notifications-state', 'error', error.message, () => loadNotifications(reset)); }
  finally { if (request === notificationRequest) { inbox.loading = false; $('notifications-more').disabled = false; $('notifications-unread').disabled = false; } }
}
async function openNotification(item) {
  const account = state.account, url = notificationUrl(item);
  // Validate the target before changing screens or marking the alert read.
  if (item.kind === 'answer') {
    await api(`/cohorts/${item.cohort_id}/questions/${item.question_id}`);
    const answers = await api(`/cohorts/${item.cohort_id}/questions/${item.question_id}/answers`);
    if (!answers.some(answer => answer.id === item.answer_id)) throw new Error('답변이 삭제되었거나 더 이상 접근할 수 없습니다.');
  }
  else {
    const rows = await api(`/cohorts/${item.cohort_id}/channels/${item.channel_id}/messages?around=${item.message_id}`);
    if (!rows.some(m => m.id === item.message_id)) throw new Error('메시지가 삭제되었거나 더 이상 접근할 수 없습니다.');
  }
  if (account !== state.account) return;
  $('notifications-dialog').close(); saveDrafts(); history.pushState(null, '', url); await loadCohorts(item.cohort_id);
  const arrived = item.kind === 'answer'
    ? state.question?.id === item.question_id && !!document.getElementById(`answer-${item.answer_id}`)
    : state.channel?.id === item.channel_id && state.messageMap.has(item.message_id);
  if (!arrived || account !== state.account) throw new Error('알림의 대상을 불러오지 못했습니다. 다시 시도해 주세요.');
  await api(`/notifications/${item.id}/read`, { method: 'POST', json: { read: true } });
  await refreshNotificationCount(true);
}
$('notifications-btn').addEventListener('click', () => { closeNav(); $('notifications-dialog').showModal(); void loadNotifications(); });
$('notifications-close').addEventListener('click', () => $('notifications-dialog').close());
$('notifications-dialog').addEventListener('close', () => { notificationRequest++; inbox.loading = false; inbox.items = []; inbox.cursor = null; $('notifications-list').replaceChildren(); regionState('notifications-state'); regionState('notifications-update'); $('notifications-unread').disabled = false; });
$('notifications-unread').addEventListener('change', () => void loadNotifications());
$('notifications-more').addEventListener('click', () => void loadNotifications(false));
$('notifications-read-all').addEventListener('click', async () => {
  const through = Math.max(0, ...inbox.items.map(n => n.id)), account = state.account;
  if (!through) return;
  $('notifications-read-all').disabled = true;
  try {
    await api('/notifications/read-all', { method: 'POST', json: { through_id: through } });
    if (account !== state.account) return;
    await loadNotifications();
  } catch (error) { status(error.message, true); renderNotifications(); }
});

/* ---------- screen share (LiveKit SFU) ---------- */
async function loadMediaAvailability() {
  const account = state.account;
  try { const health = await api('/health'); if (state.account === account) state.mediaAvailable = health.sfu_configured === true; }
  catch { if (state.account === account) state.mediaAvailable = false; }
  if (state.account === account) updateControls();
}
const MEDIA_MESSAGES = {
  idle: '연결하면 공유 화면을 볼 수 있습니다.',
  connecting: '화면 공유 서버에 연결하고 있습니다…',
  waiting: '연결되었습니다. 발표자의 공유 화면을 기다리고 있습니다.',
  viewing: '공유 화면을 보고 있습니다. 원본이 지원하면 최대 1080p로 수신합니다.',
  sharing: '이 채널에 화면을 공유하고 있습니다.',
  reconnecting: '네트워크 연결을 복구하고 있습니다…',
  disconnected: '화면 공유 연결이 끊겼습니다. 다시 연결해 주세요.',
  failed: '화면 공유에 연결하지 못했습니다. 다시 연결해 주세요.',
};
let presentationState = { session: null, requests: [] };
let pendingPresentationIds = new Set(), wasSharing = false;
function renderPresentationRequests(data) {
  presentationState = data;
  const requests = data.requests || [];
  const owner = !!classroomSession.active?.control;
  const pending = requests.filter(r => r.status === 'pending');
  const activeIds = new Set(pending.map(r => r.id));
  if (owner && pending.some(r => !pendingPresentationIds.has(r.id))) status('학생의 화면 공유 요청이 도착했습니다. 화면 공유 패널에서 확인하세요.');
  pendingPresentationIds = activeIds;
  $('media-request-count').textContent = owner && pending.length ? ` (${pending.length})` : '';
  $('media-requests').classList.toggle('hidden', !owner);
  $('media-request-list').replaceChildren(...requests.filter(r => ['pending','approved'].includes(r.status)).map(request => {
    const decide = action => async event => {
      event.currentTarget.disabled = true;
      try { await classroomSession.decidePresentation(request.id, action); }
      catch (error) { status(error.message, true); event.currentTarget.disabled = false; }
    };
    return el('li', {}, el('span', { text: `${request.display_name} — ${request.status === 'approved' ? '발표 허용됨' : '대기 중'}` }),
      ...(request.status === 'pending' ? [el('button', { text: '허용', onclick: decide('approve') }), el('button', { text: '거절', onclick: decide('deny') })]
        : [el('button', { text: '발표 종료 / 강사로 전환', onclick: decide('revoke') })]));
  }));
  const own = requests.find(r => r.account_id === state.account?.id);
  const messages = { pending: '강사의 허용을 기다리고 있습니다.', approved: '허용되었습니다. 연결 후 “화면 선택하고 공유”를 눌러 주세요.',
    denied: '강사가 요청을 거절했습니다. 필요하면 다시 요청하세요.', revoked: '강사가 발표를 종료했습니다.', cancelled: '발표 요청을 취소했습니다.' };
  $('media-request-status').textContent = !isManager() && own ? messages[own.status] || '' : '';
  updateControls();
}
const classroomSession = new ClassroomSession({
  api,
  onUpdate: renderPresentationRequests,
  onChanged: async active => {
    const generation = classroomSession.generation;
    const config = await classroomSession.token();
    if (classroomSession.active !== active || classroomSession.generation !== generation) return;
    await media.leave();
    if (classroomSession.active === active && classroomSession.generation === generation) await media.connect(active.cohort, active.channel, config);
  },
  onLost: () => {
    void leaveMedia().then(() => status('강의실 공유 세션이 종료되었거나 연결이 끊겼습니다. 다시 연결해 주세요.', true));
  },
});
async function loadMediaClassrooms() {
  const cohort = state.cohort;
  if (!cohort || !isManager() || media.room || media.phase === 'connecting') return;
  const channel = state.channel;
  const labs = await api(`/cohorts/${cohort.id}/classrooms`);
  if (state.cohort !== cohort || state.channel !== channel || media.room || media.phase === 'connecting') return;
  const selectedClassroom = $('media-classroom').value;
  $('media-classroom').replaceChildren(el('option', { value: '', text: '시청만 하기' }),
    ...labs.map(lab => el('option', { value: lab.id, text: lab.name })));
  if (labs.some(lab => lab.id === selectedClassroom)) $('media-classroom').value = selectedClassroom;
  $('media-classroom-label').classList.toggle('hidden', !labs.length);
}
const media = new ClassroomMedia({
  loadSdk: () => import('livekit-client'),
  token: (cohort, channel) => classroomSession.join(cohort, channel, isManager() ? $('media-classroom').value : ''),
  onTrack: track => {
    const video = $('media-video');
    if (track) track.attach(video); else video.srcObject = null;
    video.classList.toggle('connected', !!track);
  },
  onState: phase => {
    $('media-status').textContent = MEDIA_MESSAGES[phase];
    $('media-status').setAttribute('role', 'status');
    $('media-connect').textContent = phase === 'connecting' ? '연결 취소' : media.room ? '연결 끊기' : '연결하기';
    $('media-stop').classList.toggle('hidden', !media.sharing);
    const studentStopped = wasSharing && !media.sharing && phase === 'waiting' && state.cohort?.role === 'student';
    wasSharing = media.sharing;
    if (studentStopped) void classroomSession.cancelPresentation().catch(error => status(error.message, true));
    $('media-classroom').disabled = !!media.room || phase === 'connecting';
    if (phase === 'failed' || phase === 'disconnected') void classroomSession.leave();
    updateControls();
  },
});
async function leaveMedia() {
  const leaving = classroomSession.leave();
  await media.leave();
  await leaving;
}

$('media-connect').addEventListener('click', async () => {
  try {
    if (media.room || media.phase === 'connecting') { await leaveMedia(); return; }
    if (!state.cohort || !state.channel) throw new Error('채널을 선택하세요');
    await media.connect(state.cohort.id, state.channel.id);
  } catch (error) { $('media-status').textContent = `화면 공유에 연결하지 못했습니다. ${errorMessage(error.message)}`; }
});

$('media-start').addEventListener('click', async () => {
  try {
    await media.start();
  } catch (error) { status(error.message, true); }
});

$('media-request').addEventListener('click', async () => {
  $('media-request').disabled = true;
  try { await classroomSession.requestPresentation(); } catch (error) { status(error.message, true); }
  finally { updateControls(); }
});
$('media-cancel-request').addEventListener('click', async () => {
  try { await classroomSession.cancelPresentation(); } catch (error) { status(error.message, true); }
});

$('media-stop').addEventListener('click', async () => {
  try {
    await media.stop();
  } catch (error) { status(error.message, true); }
});

if (matchMedia('(max-width: 1100px)').matches) $('members-toggle').setAttribute('aria-pressed', 'false');
installKoreanValidation();
boot();
