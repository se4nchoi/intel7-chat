import { api, channelSocket, fileDownloadUrl, uploadFile } from './api.js';

const $ = (id) => document.getElementById(id);
const state = { account: null, cohorts: [], cohort: null, channel: null, socket: null, question: null, mediaRoom: null };

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = `info ${error ? 'error' : 'muted'}`;
}

function textNode(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function dateLabel(value) {
  return value ? new Date(value).toLocaleString() : '';
}

function showAccount() {
  const loggedIn = Boolean(state.account);
  $('login-card').classList.toggle('hidden', loggedIn);
  $('hub-app').classList.toggle('hidden', !loggedIn);
  $('account-label').textContent = loggedIn ? `@${state.account.username}` : '';
  $('admin-card').classList.toggle('hidden', !state.account?.is_admin);
}

async function boot() {
  try {
    state.account = await api('/me');
    showAccount();
    await loadCohorts();
  } catch (error) {
    state.account = null;
    showAccount();
    status('Log in to the PostgreSQL hub.');
  }
}

async function loadCohorts(preferredId) {
  state.cohorts = await api('/cohorts');
  const select = $('cohort-select');
  select.replaceChildren(...state.cohorts.map(cohort => new Option(cohort.name, String(cohort.id))));
  const chosen = state.cohorts.find(c => c.id === Number(preferredId)) || state.cohorts[0];
  if (!chosen) {
    state.cohort = null;
    status('No cohort assigned yet. An administrator can create one.');
    return;
  }
  select.value = String(chosen.id);
  await selectCohort(chosen.id);
}

async function selectCohort(id) {
  state.cohort = state.cohorts.find(c => c.id === Number(id));
  if (!state.cohort) return;
  if (state.socket) state.socket.close();
  state.socket = null;
  await leaveMedia();
  $('role-label').textContent = `${state.cohort.role}${state.cohort.archived ? ' · archived' : ''}`;
  $('manage-card').classList.toggle('hidden', !['admin', 'instructor'].includes(state.cohort.role));
  $('media-start').classList.toggle('hidden', !['admin', 'instructor'].includes(state.cohort.role));
  await Promise.all([loadChannels(), loadQuestions(), loadFiles()]);
  status(`Connected to ${state.cohort.name}. Chat, Q&A, and file records are stored in PostgreSQL.`);
}

async function loadChannels() {
  const channels = await api(`/cohorts/${state.cohort.id}/channels`);
  const list = $('channel-list');
  list.replaceChildren();
  for (const channel of channels) {
    const button = textNode('button', `# ${channel.name}`);
    button.addEventListener('click', () => selectChannel(channel));
    list.append(button);
  }
  if (channels.length) await selectChannel(channels[0]);
}

async function selectChannel(channel) {
  if (state.socket) state.socket.close();
  if (state.channel && state.channel.id !== channel.id) await leaveMedia();
  state.channel = channel;
  for (const button of $('channel-list').children) button.classList.toggle('active', button.textContent === `# ${channel.name}`);
  const messages = await api(`/cohorts/${state.cohort.id}/channels/${channel.id}/messages`);
  $('messages').replaceChildren();
  messages.forEach(appendMessage);
  const socket = channelSocket(state.cohort.id, channel.id);
  state.socket = socket;
  socket.onmessage = (event) => {
    if (state.socket !== socket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === 'message') appendMessage(payload.message);
  };
  socket.onclose = () => { if (state.socket === socket) status('Chat connection closed. Reload to reconnect.', true); };
}

function appendMessage(message) {
  const row = document.createElement('div');
  row.className = 'message';
  row.append(textNode('strong', message.display_name || message.username), textNode('time', dateLabel(message.created_at)));
  row.append(document.createElement('br'), textNode('span', message.body));
  $('messages').append(row);
  $('messages').scrollTop = $('messages').scrollHeight;
}

async function loadQuestions() {
  const questions = await api(`/cohorts/${state.cohort.id}/questions`);
  const list = $('question-list');
  list.replaceChildren();
  if (!questions.length) list.append(textNode('li', 'No questions yet.', 'muted'));
  for (const question of questions) {
    const row = document.createElement('li');
    const button = textNode('button', question.title);
    button.addEventListener('click', () => selectQuestion(question));
    row.append(button, textNode('small', ` ${question.answer_count} answers · @${question.username}`, 'muted'));
    row.append(document.createElement('br'), textNode('span', question.body));
    list.append(row);
  }
  $('answer-panel').open = false;
}

async function selectQuestion(question) {
  state.question = question;
  $('answer-heading').textContent = `Answers: ${question.title}`;
  $('answer-panel').open = true;
  const answers = await api(`/cohorts/${state.cohort.id}/questions/${question.id}/answers`);
  const list = $('answer-list');
  list.replaceChildren();
  if (!answers.length) list.append(textNode('li', 'No answers yet.', 'muted'));
  for (const answer of answers) list.append(textNode('li', `@${answer.username}: ${answer.body}`));
}

async function loadFiles() {
  const files = await api(`/cohorts/${state.cohort.id}/files`);
  const list = $('file-list');
  list.replaceChildren();
  if (!files.length) list.append(textNode('li', 'No files yet.', 'muted'));
  for (const file of files) {
    const row = document.createElement('li');
    const link = textNode('a', file.original_name);
    link.href = fileDownloadUrl(state.cohort.id, file.id);
    row.append(link, textNode('small', ` · @${file.username} · ${Math.ceil(file.size_bytes / 1024)} KB`, 'muted'));
    list.append(row);
  }
}

function formValues(form) { return Object.fromEntries(new FormData(form)); }

function handleForm(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit], button:not([type])');
    if (button) button.disabled = true;
    try { await action(form); form.reset(); }
    catch (error) { status(error.message, true); }
    finally { if (button) button.disabled = false; }
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
  if (state.socket) state.socket.close();
  await leaveMedia();
  state.account = null;
  showAccount();
  status('Logged out.');
});

$('cohort-select').addEventListener('change', event => selectCohort(event.target.value).catch(error => status(error.message, true)));

handleForm('message-form', async () => {
  if (!state.cohort || !state.channel) throw new Error('Choose a channel first');
  const body = $('message-input').value.trim();
  if (!body) return;
  const message = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/messages`, { method: 'POST', json: { body } });
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) appendMessage(message);
});

handleForm('question-form', async form => {
  await api(`/cohorts/${state.cohort.id}/questions`, { method: 'POST', json: formValues(form) });
  await loadQuestions();
});

handleForm('answer-form', async form => {
  if (!state.question) throw new Error('Choose a question');
  await api(`/cohorts/${state.cohort.id}/questions/${state.question.id}/answers`, { method: 'POST', json: formValues(form) });
  await loadQuestions();
  await selectQuestion(state.question);
});

handleForm('file-form', async form => {
  await uploadFile(state.cohort.id, form);
  await loadFiles();
});

handleForm('account-form', async form => {
  await api('/accounts', { method: 'POST', json: formValues(form) });
  status('Account created. Add it to a cohort.');
});

handleForm('cohort-form', async form => {
  const cohort = await api('/cohorts', { method: 'POST', json: formValues(form) });
  await loadCohorts(cohort.id);
  status('Cohort created. Add members and channels.');
});

handleForm('membership-form', async form => {
  await api(`/cohorts/${state.cohort.id}/memberships`, { method: 'POST', json: formValues(form) });
  status('Membership saved.');
});

handleForm('channel-form', async form => {
  await api(`/cohorts/${state.cohort.id}/channels`, { method: 'POST', json: formValues(form) });
  await loadChannels();
  status('Channel created.');
});

async function leaveMedia() {
  if (state.mediaRoom) {
    state.mediaRoom.disconnect();
    state.mediaRoom = null;
  }
  $('media-video').srcObject = null;
  $('media-status').textContent = 'Connect to the media room to view a share.';
  $('media-stop').classList.add('hidden');
}

$('media-connect').addEventListener('click', async () => {
  try {
    if (!state.cohort || !state.channel) throw new Error('Choose a channel');
    await leaveMedia();
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const config = await api(`/cohorts/${state.cohort.id}/channels/${state.channel.id}/media-token`, { method: 'POST' });
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video) track.attach($('media-video'));
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach());
    room.on(RoomEvent.Disconnected, () => { $('media-status').textContent = 'Media connection closed.'; });
    await room.connect(config.url, config.token);
    state.mediaRoom = room;
    $('media-status').textContent = `Connected to SFU room ${config.room}.`;
  } catch (error) { status(error.message, true); }
});

$('media-start').addEventListener('click', async () => {
  try {
    if (!state.mediaRoom) throw new Error('Connect to the media room first');
    await state.mediaRoom.localParticipant.setScreenShareEnabled(true, { audio: false });
    $('media-status').textContent = 'Sharing screen through the SFU.';
    $('media-stop').classList.remove('hidden');
  } catch (error) { status(error.message, true); }
});

$('media-stop').addEventListener('click', async () => {
  try {
    await state.mediaRoom?.localParticipant.setScreenShareEnabled(false);
    $('media-stop').classList.add('hidden');
    $('media-status').textContent = 'Screen sharing stopped; still connected as a viewer.';
  } catch (error) { status(error.message, true); }
});

boot();
