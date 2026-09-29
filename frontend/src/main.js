import { errorMessage, installKoreanValidation } from './korean.js';
import { api, cohortSocket, fileDownloadUrl, uploadFile } from './api.js';
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
  channelList: [], unread: new Map(), online: new Set(), members: [], holding: null, historyLoaded: false, ackTimer: null,
  messageMap: new Map(), pins: [], dms: [],
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
// Authors delete their own posts; instructors and admins any post in their cohort. Archived cohorts are read-only.
const isDM = () => state.channel?.kind === 'dm';
const canDelete = item => !!state.cohort && !state.cohort.archived && (item.username === state.account?.username || (isManager() && !isDM()));
// Only authors edit, so nobody's words are changed under their name.
const canEdit = item => !!state.cohort && !state.cohort.archived && item.username === state.account?.username;
function editedMark(item) {
  return item.edited_at ? el('span', { class: 'edited', text: '(수정됨)', title: `${new Date(item.edited_at).toLocaleString('ko-KR')}에 수정` }) : null;
}
// One place that turns stored text into what is shown, so formatting can be added here later.
function renderBody(node, text) { node.textContent = text; return node; }
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
  $('accounts-card').classList.toggle('hidden', !state.account?.is_admin);
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
  state.channelList = []; state.unread = new Map(); state.online = new Set(); state.members = []; state.holding = null; state.historyLoaded = false;
  state.messageMap = new Map(); state.pins = []; state.dms = []; renderPins();
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
  $('hub-app').classList.toggle('board-mode', !!cohort && !chat);
  $('cohort-name').textContent = cohort?.name || '마디';
  $('role-label').textContent = cohort ? `${ROLE_LABEL[cohort.role] || '구성원'}${cohort.archived ? ' · 종료됨' : ''}` : '';
  $('role-label').className = `role-chip ${roleClass(cohort?.role)}`;
  const manage = !!cohort && isManager();
  $('manage-card').classList.toggle('hidden', !manage);
  $('cohort-status').classList.toggle('hidden', !cohort || !state.account?.is_admin);
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
  updateTitle();
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
    if (state.space === 'chat') { connectChat(state.cohort); await Promise.all([loadChannels(), loadMembers(), loadDMs()]); }
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
  state.channelList = channels;
  renderChannelList();
  if (channels.length) await selectChannel(channels.find(c => c.id === state.channels.get(cohort.id)) || channels[0]);
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
    $('dm-picker').close(); closeNav(); $('hub-app').classList.remove('members-open');
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
  try { members = await api(`/cohorts/${cohort.id}/members`); } catch { return; }
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
async function selectChannel(channel) {
  const epoch = state.epoch, channelEpoch = ++state.channelEpoch, cohort = state.cohort;
  await leaveMedia();
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  state.channel = channel; state.channels.set(cohort.id, channel.id); state.lastMessage = null; state.lastSeenId = 0;
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
        el('p', { class: 'muted', text: `${cohort.name}의 #${channel.name} 채널입니다. 최근 메시지 100개까지 표시됩니다.` })));
  renderChannelList(); updateControls();
  // Live messages for this channel are held while its history loads, then applied in order.
  const history = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages`);
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  history.forEach(receive);
  state.historyLoaded = true;
  state.pins = history.filter(m => m.pinned_at); renderPins(); loadPins().catch(() => {});
  flushHolding();
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
  const send = () => {
    const cohort = state.cohort, channel = state.channel, upTo = state.lastSeenId;
    if (!cohort || !channel || document.visibilityState !== 'visible') return;
    state.unread.set(channel.id, { unread: 0, mentions: 0 }); renderChannelList();
    if (upTo) api(`/cohorts/${cohort.id}/channels/${channel.id}/read`, { method: 'POST', json: { message_id: upTo } }).catch(() => { /* retried on next message */ });
  };
  if (now) send(); else state.ackTimer = setTimeout(send, 800);
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
  let opened = false;
  socket.onmessage = event => { if (state.socket === socket) handleEvent(JSON.parse(event.data)); };
  socket.onopen = async () => {
    opened = true;
    try {
      await Promise.all([catchUp(), loadUnread()]);
      if (retry && state.socket === socket) status('채팅에 다시 연결되었습니다.');
    } catch (error) {
      if (state.socket === socket) { status(error.message, true); socket.close(); }
    }
  };
  socket.onclose = async event => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.online = new Set(); renderMembers();
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
      if (current()) connectChat(cohort, next);
    };
    state.reconnectTimer = setTimeout(reconnect, delay); state.reconnectNow = reconnect;
  };
}
// Skip the wait when the network or the tab comes back.
addEventListener('online', () => state.reconnectNow?.());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { state.reconnectNow?.(); if (state.historyLoaded) ackRead(true); } });
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
  row.append(reactionsNode(message));
  const actions = messageActions(message, row);
  if (actions) row.append(actions);
  box.append(row);
  state.lastMessage = message;
  if (nearBottom || message.username === state.account?.username) box.scrollTop = box.scrollHeight;
}
function messageActions(message, row) {
  const name = message.display_name || message.username;
  const writable = !!state.cohort && !state.cohort.archived;
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
  $('pins-list').replaceChildren(...(count ? state.pins.map(pin => el('li', {},
    el('button', { type: 'button', class: 'pin-item', onclick: () => jumpTo(pin.id) },
      el('strong', { text: pin.display_name || pin.username }), el('small', { class: 'muted', text: ` · ${stamp(pin.created_at)}` }),
      renderBody(el('span', { class: 'pin-text' }), pin.body)))) : [el('li', { class: 'muted', text: isManager() ? '고정된 메시지가 없습니다. 메시지에 마우스를 올려 📌 고정을 누르세요.' : '고정된 메시지가 없습니다.' })]));
}
function jumpTo(messageId) {
  const row = $('messages').querySelector(`[data-message-id="${messageId}"]`);
  if (!row) { status('오래된 메시지라 화면에 없습니다. 최근 100개만 표시됩니다.'); return; }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600);
}
$('pins-toggle').addEventListener('click', event => {
  const hidden = $('pins-panel').classList.toggle('hidden');
  event.currentTarget.setAttribute('aria-pressed', String(!hidden));
  if (!hidden) loadPins().catch(error => status(error.message, true));
});
function startEditMessage(message, row) {
  if (row.classList.contains('editing')) return;
  const body = row.querySelector('.msg-body'), original = [...body.childNodes];
  const current = row.querySelector('.msg-text').textContent;
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
  $('post-body').replaceChildren(...[renderBody(el('span'), question.body), editedMark(question)].filter(Boolean));
  $('post-delete').classList.toggle('hidden', !canDelete(question));
  $('post-edit').classList.toggle('hidden', !canEdit(question));
  $('post-edit-form').classList.add('hidden'); $('post-content').classList.remove('hidden');
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
      if (epoch === state.epoch && state.question?.id === question.id) await selectQuestion(state.question, false);
      status('답변을 수정했습니다.');
    } catch (error) { status(error.message, true); }
  });
  body.replaceChildren(form); input.focus();
}
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
  if (state.question?.id === question.id) await selectQuestion(state.question, false);
  status('질문을 수정했습니다.');
});
async function deleteAnswer(answer) {
  if (!confirm('이 답변을 삭제할까요?')) return;
  const epoch = state.epoch, question = state.question;
  try {
    await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers/${answer.id}`, { method: 'DELETE' });
    if (epoch !== state.epoch) return;
    await loadQuestions();
    if (epoch === state.epoch && state.question?.id === question.id) await selectQuestion(state.question, false);
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
  const accounts = await api('/accounts');
  const cohortName = new Map(state.cohorts.map(c => [c.id, c.name]));
  $('account-list').replaceChildren(...accounts.map(account => {
    const self = account.id === state.account.id;
    const where = account.is_admin ? '관리자' : account.memberships.map(m => `${cohortName.get(m.cohort_id) || `#${m.cohort_id}`} ${ROLE_LABEL[m.role] || m.role}`).join(', ') || '소속 없음';
    return el('li', { class: account.active ? '' : 'inactive' },
      el('span', { class: 'who', text: `${account.display_name} (@${account.username}) · ${where}`, title: where }),
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
$('manage-btn').addEventListener('click', () => {
  $('temp-password').classList.add('hidden'); $('temp-password').textContent = '';
  $('management').showModal();
  refreshManagement().catch(error => status(error.message, true));
});
$('add-channel-btn').addEventListener('click', () => { $('management').showModal(); $('channel-form').elements.slug.focus(); refreshManagement().catch(error => status(error.message, true)); });
$('management-close').addEventListener('click', () => $('management').close());
$('management').addEventListener('close', () => { $('temp-password').classList.add('hidden'); $('temp-password').textContent = ''; });

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
