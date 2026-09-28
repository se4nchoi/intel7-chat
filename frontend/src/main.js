import { errorMessage, installKoreanValidation } from './korean.js';
import { api, channelSocket, fileDownloadUrl, uploadFile } from './api.js';
import { readRoute, spaceUrl } from './navigation.js';

const $ = id => document.getElementById(id);
let cohortRequest = 0;
const state = { account: null, cohorts: [], cohort: null, channel: null, socket: null, question: null, mediaRoom: null, space: readRoute(location.pathname).space, epoch: 0, channelEpoch: 0, questionEpoch: 0, mediaEpoch: 0, channels: new Map() };
function status(message, error = false) { $('status').textContent = error ? errorMessage(message) : message; $('status').className = `info ${error ? 'error' : 'muted'}`; }
function textNode(tag, value, className = '') { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; }
function dateLabel(value) { return value ? new Date(value).toLocaleString('ko-KR') : ''; }
function closeChat() { const socket = state.socket; state.socket = null; socket?.close(); }
function showAccount() {
  $('login-card').classList.toggle('hidden', !!state.account);
  $('hub-app').classList.toggle('hidden', !state.account);
  $('account-label').textContent = state.account ? `@${state.account.username}` : '';
  $('admin-card').classList.toggle('hidden', !state.account?.is_admin);
}
function updateControls() {
  const writable = !!state.cohort && !state.cohort.archived;
  for (const id of ['message-form', 'question-form', 'answer-form', 'file-form', 'membership-form', 'channel-form']) {
    const enabled = writable && (id !== 'message-form' || !!state.channel) && (id !== 'answer-form' || !!state.question);
    for (const control of $(id).elements) control.disabled = !enabled;
  }
  $('media-connect').disabled = !writable || !state.channel;
  $('media-start').disabled = !writable || !state.mediaRoom;
}
function resetContent() {
  state.epoch++; state.channelEpoch++; state.questionEpoch++;
  closeChat(); void leaveMedia().catch(error => status(error.message, true));
  state.channel = null; state.question = null;
  for (const id of ['channel-list','messages','question-list','answer-list','file-list']) $(id).replaceChildren();
  $('channel-heading').textContent = '채널을 선택하세요';
  $('answer-heading').textContent = '답변'; $('answer-panel').open = false;
  updateControls();
}
function showSpace() {
  const cohort = state.cohort;
  $('chat-space').classList.toggle('hidden', !cohort || state.space !== 'chat');
  $('board-space').classList.toggle('hidden', !cohort || state.space !== 'board');
  $('empty-space').classList.toggle('hidden', !!cohort);
  $('role-label').textContent = cohort ? `${({admin: '관리자', instructor: '강사', student: '수강생'})[cohort.role] || '구성원'}${cohort.archived ? ' · 종료됨' : ''}` : '';
  const manage = cohort && ['admin','instructor'].includes(cohort.role);
  $('manage-card').classList.toggle('hidden', !manage);
  $('management').classList.toggle('hidden', !manage && !state.account?.is_admin);
  $('media-start').classList.toggle('hidden', !manage);
  const instructorOption = $('membership-form').elements.role.querySelector('[value="instructor"]');
  instructorOption.disabled = !state.account?.is_admin;
  if (!state.account?.is_admin) $('membership-form').elements.role.value = 'student';
  for (const space of ['chat','board']) {
    const link = $(`${space}-link`);
    link.href = cohort ? spaceUrl(cohort.slug, space) : '/hub';
    if (space === state.space) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
    $(`${space}-cohort`).textContent = cohort?.name || '';
  }
  document.title = `대나무챗 · ${state.space === 'chat' ? '채팅' : '질문 게시판 · 자료실'}${cohort ? ` · ${cohort.name}` : ''}`;
  updateControls();
}
async function boot() {
  try { state.account = await api('/me'); }
  catch (error) { showAccount(); status('로그인하고 우리 반 학습 공간에 참여하세요.'); return; }
  showAccount();
  try { await loadCohorts(); } catch (error) { status(error.message, true); }
}
async function loadCohorts(preferredId) {
  const request = ++cohortRequest, account = state.account;
  const cohorts = await api('/cohorts');
  if (request !== cohortRequest || state.account !== account) return;
  state.cohorts = cohorts;
  $('cohort-select').replaceChildren(...state.cohorts.map(c => new Option(c.name,String(c.id))));
  const route = readRoute(location.pathname);
  state.space = route.space;
  const chosen = preferredId ? state.cohorts.find(c => c.id === Number(preferredId)) : route.slug ? state.cohorts.find(c => c.slug === route.slug) : state.cohorts[0];
  if (!chosen) {
    state.cohort = null; resetContent(); showSpace(); $('cohort-select').selectedIndex = -1;
    status(route.slug ? '이 수강반에 접근할 수 없습니다. 참여 중인 수강반을 선택하세요.' : '아직 배정된 수강반이 없습니다. 강사에게 참여 권한을 요청하세요.');
    return;
  }
  await selectCohort(chosen.id, 'replace');
}
async function selectCohort(id, historyMode = 'push') {
  const next = state.cohorts.find(c => c.id === Number(id));
  if (!next) return;
  if (state.cohort?.id !== next.id) {
    for (const id of ['message-form','question-form','answer-form','file-form','membership-form','channel-form']) $(id).reset();
  }
  state.cohort = next; $('cohort-select').value = String(next.id);
  const url = spaceUrl(next.slug,state.space);
  if (historyMode === 'replace') history.replaceState(null,'',url);
  else if (location.pathname !== url) history.pushState(null,'',url);
  await loadSpace();
}
async function loadSpace() {
  resetContent(); showSpace();
  const epoch = state.epoch;
  status(`${state.space === 'chat' ? '채팅을' : '게시판을'} 불러오는 중입니다…`);
  try {
    if (state.space === 'chat') await loadChannels();
    else await Promise.all([loadQuestions(),loadFiles()]);
    if (epoch === state.epoch) status(state.cohort.archived ? '종료된 수강반입니다. 기존 내용만 열람할 수 있습니다.' : '');
  } catch (error) { if (epoch === state.epoch) status(error.message,true); }
}
for (const space of ['chat','board']) {
  $(`${space}-link`).addEventListener('click', async event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!state.cohort || state.space === space) return;
    state.space = space; history.pushState(null,'',spaceUrl(state.cohort.slug,space));
    await loadSpace(); $(`${state.space}-heading`).focus();
  });
}
window.addEventListener('popstate', () => { if (state.account) loadCohorts().catch(error => status(error.message,true)); });

async function loadChannels() {
  const epoch = state.epoch, cohort = state.cohort;
  const channels = await api(`/cohorts/${cohort.id}/channels`);
  if (epoch !== state.epoch) return;
  const list = $('channel-list'); list.replaceChildren();
  for (const channel of channels) {
    const button = textNode('button', `# ${channel.name}`); button.dataset.id = channel.id;
    button.addEventListener('click', () => selectChannel(channel).catch(error => status(error.message,true)));
    list.append(button);
  }
  if (channels.length) await selectChannel(channels.find(c => c.id === state.channels.get(cohort.id)) || channels[0]);
  else { $('messages').append(textNode('p','아직 채널이 없습니다. 강사에게 채널 개설을 요청하세요.','muted')); updateControls(); }
}
async function selectChannel(channel) {
  const epoch = state.epoch, channelEpoch = ++state.channelEpoch, cohort = state.cohort;
  closeChat(); await leaveMedia();
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  state.channel = channel; state.channels.set(cohort.id,channel.id);
  $('channel-heading').textContent = `# ${channel.name}`; $('messages').replaceChildren(); updateControls();
  for (const button of $('channel-list').children) { const active = button.dataset.id === String(channel.id); button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active)); }
  const messages = await api(`/cohorts/${cohort.id}/channels/${channel.id}/messages`);
  if (epoch !== state.epoch || channelEpoch !== state.channelEpoch) return;
  messages.forEach(appendMessage);
  const socket = channelSocket(cohort.id,channel.id); state.socket = socket;
  socket.onmessage = event => { if (state.socket !== socket) return; const payload = JSON.parse(event.data); if (payload.type === 'message') appendMessage(payload.message); };
  socket.onclose = () => { if (state.socket === socket) status('채팅 연결이 끊겼습니다. 새로고침하여 다시 연결하세요.',true); };
}
function appendMessage(message) {
  const row = textNode('div','','message');
  row.append(textNode('strong',message.display_name || message.username),textNode('time',dateLabel(message.created_at)),document.createElement('br'),textNode('span',message.body));
  $('messages').append(row); $('messages').scrollTop = $('messages').scrollHeight;
}
async function loadQuestions() {
  const epoch = state.epoch, cohort = state.cohort;
  const questions = await api(`/cohorts/${cohort.id}/questions`);
  if (epoch !== state.epoch) return;
  const list = $('question-list'); list.replaceChildren();
  if (!questions.length) list.append(textNode('li','아직 질문이 없습니다. 아래에서 첫 질문을 남겨 보세요.','muted'));
  for (const question of questions) {
    const row = document.createElement('li'), button = textNode('button',question.title);
    button.addEventListener('click',() => selectQuestion(question).catch(error => status(error.message,true)));
    row.append(button,textNode('small',`답변 ${question.answer_count}개 · @${question.username}`,'muted'),textNode('span',question.body)); list.append(row);
  }
}
async function selectQuestion(question) {
  const epoch = state.epoch, questionEpoch = ++state.questionEpoch, cohort = state.cohort;
  state.question = question; $('answer-heading').textContent = `답변: ${question.title}`; $('answer-panel').open = true; $('answer-list').replaceChildren(); updateControls();
  const answers = await api(`/cohorts/${cohort.id}/questions/${question.id}/answers`);
  if (epoch !== state.epoch || questionEpoch !== state.questionEpoch) return;
  const list = $('answer-list');
  if (!answers.length) list.append(textNode('li','아직 답변이 없습니다.','muted'));
  for (const answer of answers) list.append(textNode('li',`@${answer.username}: ${answer.body}`));
}
async function loadFiles() {
  const epoch = state.epoch, cohort = state.cohort;
  const files = await api(`/cohorts/${cohort.id}/files`);
  if (epoch !== state.epoch) return;
  const list = $('file-list'); list.replaceChildren();
  if (!files.length) list.append(textNode('li','아직 공유된 자료가 없습니다.','muted'));
  for (const file of files) {
    const row = document.createElement('li'), link = textNode('a',file.original_name); link.href = fileDownloadUrl(cohort.id,file.id);
    row.append(link,textNode('small',` · @${file.username} · ${Math.ceil(file.size_bytes/1024)} KB`,'muted')); list.append(row);
  }
}

function formValues(form) { return Object.fromEntries(new FormData(form)); }

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
  const credentials = formValues(form);
  await api('/login', { method: 'POST', json: credentials });
  state.account = await api('/me');
  showAccount();
  await loadCohorts();
});

$('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.cohort = null; resetContent();
  state.account = null;
  showAccount(); showSpace();
  status('로그아웃되었습니다.');
});

$('cohort-select').addEventListener('change', event => selectCohort(event.target.value).catch(error => status(error.message, true)));

handleForm('message-form', async () => {
  if (!state.cohort || !state.channel) throw new Error('먼저 채널을 선택하세요');
  const epoch = state.epoch, channelEpoch = state.channelEpoch;
  const body = $('message-input').value.trim();
  if (!body) return;
  const message = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages`, { method: 'POST', json: { body } });
  if (epoch === state.epoch && channelEpoch === state.channelEpoch && (!state.socket || state.socket.readyState !== WebSocket.OPEN)) appendMessage(message);
});

handleForm('question-form', async form => {
  const epoch = state.epoch;
  await api(`/cohorts/${state.cohort.id}/questions`, { method: 'POST', json: formValues(form) });
  if (epoch === state.epoch) await loadQuestions();
});

handleForm('answer-form', async form => {
  if (!state.question) throw new Error('질문을 선택하세요');
  const epoch = state.epoch, question = state.question;
  await api(`/cohorts/${state.cohort.id}/questions/${state.question.id}/answers`, { method: 'POST', json: formValues(form) });
  if (epoch === state.epoch) { await loadQuestions(); if (epoch === state.epoch && state.question?.id === question.id) await selectQuestion(question); }
});

handleForm('file-form', async form => {
  const epoch = state.epoch;
  await uploadFile(state.cohort.id, form);
  if (epoch === state.epoch) await loadFiles();
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
  status('구성원 정보를 저장했습니다.');
});

handleForm('channel-form', async form => {
  await api(`/cohorts/${state.cohort.id}/channels`, { method: 'POST', json: formValues(form) });
  if (state.space === 'chat') await loadChannels();
  status('채널을 만들었습니다.');
});

async function leaveMedia() {
  state.mediaEpoch++;
  const room = state.mediaRoom;
  state.mediaRoom = null;
  $('media-video').srcObject = null;
  $('media-status').textContent = '연결하면 공유 화면을 볼 수 있습니다.';
  $('media-stop').classList.add('hidden');
  updateControls();
  if (room) await room.disconnect();
}

$('media-connect').addEventListener('click', async () => {
  try {
    if (!state.cohort || !state.channel) throw new Error('채널을 선택하세요');
    await leaveMedia();
    const epoch = state.epoch, mediaEpoch = state.mediaEpoch, cohort = state.cohort, channel = state.channel;
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const config = await api(`/cohorts/${cohort.id}/channels/${channel.id}/media-token`, { method: 'POST' });
    if (epoch !== state.epoch || mediaEpoch !== state.mediaEpoch) return;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (state.mediaRoom === room && track.kind === Track.Kind.Video) track.attach($('media-video'));
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach());
    room.on(RoomEvent.Disconnected, () => { if (state.mediaRoom === room) { state.mediaRoom = null; $('media-status').textContent = '화면 공유 연결이 끊겼습니다.'; updateControls(); } });
    state.mediaRoom = room;
    try { await room.connect(config.url, config.token); } catch (error) { if (state.mediaRoom === room) await leaveMedia(); else await room.disconnect(); throw error; }
    if (epoch !== state.epoch || mediaEpoch !== state.mediaEpoch) { await room.disconnect(); return; }
    $('media-status').textContent = '연결되었습니다. 공유 화면을 기다리고 있습니다.'; updateControls();
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

installKoreanValidation();
boot();
