// ============================================================
// BambooChat - Omok (Gomoku - 오목) Module
// Native ES Module Architecture
// ============================================================

import { state } from './state.js';
import { showToast, escapeHtml } from './utils.js';

const sameUser = (left, right) => left != null && right != null && String(left) === String(right);

let omWs = null;
let currentRoom = null;
let myColor = null; // 'b', 'w', or null
let omHistoryPreviewIndex = null;
let clockInterval = null;
let lastResultKeyHandled = null;

const $ = id => document.getElementById(id);

// Go stone clack sound effect via Web Audio API
function playStoneClickSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.05);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  } catch (e) {
    // Audio unavailable
  }
}

export function initOmokListeners() {
  window.bambooOmokHook = {
    onTabActive: () => {
      ensureOmokConnected();
      fetchOmokRooms();
    }
  };

  // Lobby tabs
  const tabRooms = $('omTabRooms');
  const tabRank = $('omTabRank');
  const btnRefreshLobby = $('omBtnRefreshLobby');
  const btnRefreshRank = $('omBtnRefreshRank');
  const btnOpenCreate = $('omBtnOpenCreate');
  const btnCancelCreate = $('omBtnCancelCreate');
  const btnSubmitCreate = $('omBtnSubmitCreate');

  if (tabRooms) tabRooms.addEventListener('click', () => switchOmLobbyTab('rooms'));
  if (tabRank) tabRank.addEventListener('click', () => switchOmLobbyTab('rank'));
  if (btnRefreshLobby) btnRefreshLobby.addEventListener('click', fetchOmokRooms);
  if (btnRefreshRank) btnRefreshRank.addEventListener('click', fetchOmokRankings);

  if (btnOpenCreate) {
    btnOpenCreate.addEventListener('click', () => {
      $('omCreatePanel').classList.toggle('hidden');
      $('omCreateTitle').focus();
    });
  }
  if (btnCancelCreate) {
    btnCancelCreate.addEventListener('click', () => $('omCreatePanel').classList.add('hidden'));
  }
  if (btnSubmitCreate) {
    btnSubmitCreate.addEventListener('click', submitCreateOmRoom);
  }

  // Game screen actions
  const btnResign = $('omBtnResign');
  const btnLeave = $('omBtnLeave');
  const btnSitBlack = $('omBtnSitBlack');
  const btnSitWhite = $('omBtnSitWhite');
  const btnStartGame = $('omBtnStartGame');
  const btnReady = $('omBtnReady');
  const btnReturnToSpec = $('omBtnReturnToSpec');

  if (btnResign) btnResign.addEventListener('click', handleResign);
  if (btnLeave) btnLeave.addEventListener('click', handleLeaveRoom);
  if (btnSitBlack) btnSitBlack.addEventListener('click', () => sendOmAction('pick_role', { role: 'b' }));
  if (btnSitWhite) btnSitWhite.addEventListener('click', () => sendOmAction('pick_role', { role: 'w' }));
  if (btnReady) btnReady.addEventListener('click', () => sendOmAction('toggle_ready'));
  if (btnReturnToSpec) btnReturnToSpec.addEventListener('click', () => sendOmAction('pick_role', { role: 'spectator' }));
  if (btnStartGame) btnStartGame.addEventListener('click', () => sendOmAction('start_game'));

  const btnReturnLive = $('omBtnReturnLive');
  if (btnReturnLive) btnReturnLive.addEventListener('click', clearOmHistoryPreview);

  const btnCancelFoul = $('omBtnCancelFoul');
  if (btnCancelFoul) btnCancelFoul.addEventListener('click', closeOmFoulModal);
  const btnConfirmFoul = $('omBtnConfirmFoul');
  if (btnConfirmFoul) {
    btnConfirmFoul.addEventListener('click', () => {
      if (pendingFoulMove) {
        const { col, row } = pendingFoulMove;
        closeOmFoulModal();
        sendOmAction('move', { col, row });
        playStoneClickSound();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeOmFoulModal();
    }
  });

  // Room chat
  const chatForm = $('omChatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('omChatInput');
      const text = (input?.value || '').trim();
      if (!text || !currentRoom) return;
      sendOmAction('chat', { text });
      input.value = '';
    });
  }
}

function ensureOmokConnected() {
  if (omWs && (omWs.readyState === WebSocket.OPEN || omWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  omWs = new WebSocket(`${protocol}//${window.location.host}/ws/omok`);

  omWs.onopen = () => {
    fetchOmokRooms();
  };

  omWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleOmMessage(msg);
    } catch (e) {
      console.error('Invalid omok message', e);
    }
  };

  omWs.onclose = () => {
    setTimeout(ensureOmokConnected, 3000);
  };
}

function sendOmAction(action, data = {}) {
  if (!omWs || omWs.readyState !== WebSocket.OPEN) return;
  const payload = { action, room_id: currentRoom?.id, ...data };
  omWs.send(JSON.stringify(payload));
}

function fetchOmokRooms() {
  sendOmAction('list_rooms');
}

function handleOmMessage(msg) {
  if (msg.type === 'lobby_update') {
    renderOmRoomList(msg.rooms || []);
  } else if (msg.type === 'room_state') {
    updateOmRoomState(msg.room);
  } else if (msg.type === 'chat') {
    appendOmChat(msg.sender, msg.text, msg.time);
  } else if (msg.type === 'error') {
    showToast(msg.message, 'error');
  }
}

function switchOmLobbyTab(tab) {
  const isRooms = tab === 'rooms';
  $('omTabRooms').classList.toggle('active', isRooms);
  $('omTabRank').classList.toggle('active', !isRooms);
  $('omLobbyActionsRooms').classList.toggle('hidden', !isRooms);
  $('omLobbyActionsRank').classList.toggle('hidden', isRooms);
  $('omRoomGrid').classList.toggle('hidden', !isRooms);
  $('omLobbyEmpty').classList.toggle('hidden', true);
  $('omRankingsPanel').classList.toggle('hidden', isRooms);

  if (!isRooms) {
    fetchOmokRankings();
  }
}

async function fetchOmokRankings() {
  try {
    const res = await fetch('/api/omok/rankings');
    const data = await res.json();
    renderOmRankings(data.rankings || []);
  } catch (e) {
    console.error('Failed to fetch omok rankings', e);
  }
}

function renderOmRankings(rankings) {
  const tbody = $('omRankingsTbody');
  const podiumRow = $('omPodiumRow');
  if (podiumRow) {
    podiumRow.replaceChildren();
    const top3 = rankings.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    top3.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = `podium-card rank-${idx + 1}`;
      card.innerHTML = `
        <span class="podium-rank-icon">${medals[idx]}</span>
        <span class="podium-name">${escapeHtml(item.display_name || item.username)}</span>
        <span class="podium-score">${item.wins || 0}승</span>
        <span class="podium-sub">승률 ${item.win_rate || 0}% · ${item.wins || 0}승 ${item.draws || 0}무 ${item.losses || 0}패</span>
      `;
      podiumRow.appendChild(card);
    });
  }

  if (!tbody) return;
  if (!rankings.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--om-muted);">아직 기록된 전적이 없습니다.</td></tr>';
    return;
  }
  const getOmBadge = (rank) => {
    if (rank === 1) return '<span class="quiz-user-badge badge-omok" style="margin-left:6px;">⚫ 오목의 신</span>';
    if (rank === 2) return '<span class="quiz-user-badge badge-omok" style="margin-left:6px;">⚪ 오목의 왕</span>';
    if (rank === 3) return '<span class="quiz-user-badge badge-omok" style="margin-left:6px;">⚫ 오목고인물</span>';
    return '';
  };

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;
  tbody.innerHTML = rankings.map(r => {
    const isMe = sameUser(r.user_id, myUserId);
    const myRowClass = isMe ? ' class="my-row"' : '';
    const meLabel = isMe ? '<span style="font-size:10.5px;color:#fcd34d;margin-left:4px;font-weight:700;">(나)</span>' : '';
    const lastWin = r.last_win_at ? String(r.last_win_at).slice(0, 16).replace('T', ' ') : '-';
    return `
    <tr${myRowClass}>
      <td style="text-align:center;font-weight:700;color:var(--om-text);">${r.rank === 1 ? '🥇 1' : r.rank === 2 ? '🥈 2' : r.rank === 3 ? '🥉 3' : r.rank}</td>
      <td style="font-weight:600;">
        <span style="color:var(--om-text);">${escapeHtml(r.display_name || r.username)}</span>${getOmBadge(r.rank)}${meLabel}
      </td>
      <td style="text-align:center;color:#fde68a;font-weight:700;">${r.wins}승</td>
      <td style="text-align:center;">${r.win_rate}%</td>
      <td style="text-align:center;color:var(--om-muted);">${r.wins}승 ${r.draws}무 ${r.losses}패</td>
      <td style="text-align:center;font-size:12px;color:var(--om-muted);">${lastWin}</td>
    </tr>
  `;
  }).join('');
}

function submitCreateOmRoom() {
  const title = ($('omCreateTitle')?.value || '').trim();
  const timeMins = parseInt($('omCreateTime')?.value || '10', 10);
  sendOmAction('create_room', { title, time_minutes: timeMins });
  $('omCreatePanel').classList.add('hidden');
}

function renderOmRoomList(rooms) {
  const grid = $('omRoomGrid');
  const empty = $('omLobbyEmpty');
  if (!grid) return;

  if (!rooms.length) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  grid.innerHTML = rooms.map(r => `
    <div class="om-room-card" data-room-id="${r.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;font-size:15px;color:#fde68a;">${r.title}</span>
        <span style="font-size:11px;background:rgba(245,158,11,0.15);color:#fcd34d;padding:2px 8px;border-radius:6px;">⏱️ ${r.time_minutes}분</span>
      </div>
      <div style="font-size:12.5px;color:var(--om-muted);display:flex;justify-content:space-between;">
        <span>黑: ${r.black || '대기 중'}</span>
        <span>白: ${r.white || '대기 중'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--om-muted);">
        <span>관전 ${r.spectator_count}명</span>
        <span style="color:${r.game_started ? '#f59e0b' : '#34d399'};font-weight:600;">${r.game_started ? '⚔️ 대국 중' : '대기 중'}</span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.om-room-card').forEach(card => {
    card.addEventListener('click', () => {
      const rId = card.getAttribute('data-room-id');
      sendOmAction('join_room', { room_id: rId });
    });
  });
}

function getOmStatText(id) {
  if (!id || !currentRoom?.stats) return '0승 0무 0패';
  const s = currentRoom.stats[id] || currentRoom.stats[String(id)];
  if (!s) return '0승 0무 0패';
  return `${s.wins || 0}승 ${s.draws || 0}무 ${s.losses || 0}패`;
}

function updateOmRoomState(room) {
  const isNewRoom = (!currentRoom && room) || (currentRoom && room && currentRoom.id !== room.id);
  currentRoom = room;
  const lobby = $('omLobbyScreen');
  const game = $('omGameScreen');

  if (!room) {
    closeOmFoulModal();
    if (lobby) lobby.classList.remove('hidden');
    if (game) game.classList.add('hidden');
    resetOmChat();
    return;
  }

  if (isNewRoom) {
    resetOmChat();
  }

  if (lobby) lobby.classList.add('hidden');
  if (game) game.classList.remove('hidden');

  // Title & ID
  $('omRoomTitle').textContent = room.title;
  $('omRoomIdBadge').textContent = `#${room.id.slice(5)}`;

  // Determine user's role
  const myId = String(state.currentUser?.id);
  myColor = null;
  if (room.black && String(room.black.id) === myId) myColor = 'b';
  if (room.white && String(room.white.id) === myId) myColor = 'w';

  // Player cards & badges
  const blackOwnerMark = room.black && String(room.owner_id) === String(room.black.id) ? '👑 ' : '';
  const whiteOwnerMark = room.white && String(room.owner_id) === String(room.white.id) ? '👑 ' : '';
  $('omBlackName').textContent = room.black ? blackOwnerMark + room.black.name : '흑 플레이어 대기 중';
  $('omWhiteName').textContent = room.white ? whiteOwnerMark + room.white.name : '백 플레이어 대기 중';

  const blackStatBadge = $('omBlackBadge');
  if (blackStatBadge) {
    blackStatBadge.classList.toggle('hidden', !room.black);
    blackStatBadge.textContent = room.black ? getOmStatText(room.black.id) : '';
  }

  const whiteStatBadge = $('omWhiteBadge');
  if (whiteStatBadge) {
    whiteStatBadge.classList.toggle('hidden', !room.white);
    whiteStatBadge.textContent = room.white ? getOmStatText(room.white.id) : '';
  }

  const blackReadyBadge = $('omBlackReadyBadge');
  if (blackReadyBadge) {
    blackReadyBadge.classList.toggle('hidden', !room.black);
    blackReadyBadge.className = 'chess-ready-badge ' + (room.black_ready ? 'is-ready' : 'not-ready');
    blackReadyBadge.textContent = room.black_ready ? 'READY' : '대기 중';
  }
  const whiteReadyBadge = $('omWhiteReadyBadge');
  if (whiteReadyBadge) {
    whiteReadyBadge.classList.toggle('hidden', !room.white);
    whiteReadyBadge.className = 'chess-ready-badge ' + (room.white_ready ? 'is-ready' : 'not-ready');
    whiteReadyBadge.textContent = room.white_ready ? 'READY' : '대기 중';
  }

  // Start & Role buttons
  const isBothSeated = !!room.black && !!room.white;
  const isPlayer = myColor !== null;
  const isWaiting = !room.game_started && !room.result;
  const isOwner = room && state.currentUser && String(room.owner_id) === String(state.currentUser.id);
  const isBothReady = isBothSeated && !!room.black_ready && !!room.white_ready;
  const isMyReady = (myColor === 'b' && room.black_ready) || (myColor === 'w' && room.white_ready);

  const btnReady = $('omBtnReady');
  if (btnReady) {
    btnReady.classList.toggle('hidden', !(isPlayer && isWaiting));
    if (isMyReady) {
      btnReady.textContent = '❌ 준비 취소';
      btnReady.className = 'om-btn-ghost';
    } else {
      btnReady.textContent = '✅ 준비';
      btnReady.className = 'om-btn-primary';
    }
  }

  const btnReturn = $('omBtnReturnToSpec');
  if (btnReturn) {
    btnReturn.classList.toggle('hidden', !(isPlayer && isWaiting));
  }

  const btnStart = $('omBtnStartGame');
  if (btnStart) {
    btnStart.classList.toggle('hidden', !(isOwner && isWaiting));
    btnStart.disabled = !isBothReady;
    if (!isBothReady) {
      if (!room.black_ready && !room.white_ready) btnStart.textContent = '⏳ 양측 준비 대기 중';
      else if (!room.black_ready) btnStart.textContent = '⏳ 흑(Black) 준비 대기 중';
      else btnStart.textContent = '⏳ 백(White) 준비 대기 중';
    } else {
      btnStart.textContent = '⚔️ 오목 대국 시작';
    }
  }

  $('omBtnSitBlack').classList.toggle('hidden', !!room.black || room.game_started);
  $('omBtnSitWhite').classList.toggle('hidden', !!room.white || room.game_started);

  // Status banner
  if (room.result) {
    closeOmFoulModal();
    $('omStatusText').textContent = `대국 종료: ${room.result.desc || ''}`;
    $('omTurnBadge').classList.add('hidden');
    if (JSON.stringify(room.result) !== lastResultKeyHandled) {
      lastResultKeyHandled = JSON.stringify(room.result);
      const res = room.result;
      if (!res.winner) {
        showToast(`🤝 오목 무승부: ${res.desc || '무승부로 종료되었습니다.'}`, 'info');
      } else if (myColor) {
        if (res.winner === myColor) {
          showToast(`🎉 오목 승리! ${res.desc || '축하합니다! 대국에서 승리하셨습니다.'}`, 'success');
        } else {
          showToast(`💀 오목 패배: ${res.desc || '아쉽게도 대국에서 패배하였습니다.'}`, 'warning');
        }
      } else {
        const winnerName = res.winner === 'b' ? '흑(Black)' : '백(White)';
        showToast(`⚫ 오목 대국 종료: ${winnerName} 승리 (${res.desc || ''})`, 'info');
      }
    }
  } else {
    lastResultKeyHandled = null;
    if (room.game_started) {
      $('omTurnBadge').classList.remove('hidden');
      $('omTurnText').textContent = `${room.active_turn === 'b' ? '흑(Black)' : '백(White)'} 차례`;
      $('omStatusText').textContent = `${room.move_history?.length || 0}수 진행 중`;
    } else {
      $('omTurnBadge').classList.add('hidden');
      if (!isBothSeated) {
        $('omStatusText').textContent = '상대 플레이어 착석을 기다리는 중입니다.';
      } else if (!isBothReady) {
        $('omStatusText').textContent = '양측 플레이어 준비(Ready)를 기다리는 중입니다.';
      } else {
        $('omStatusText').textContent = '👑 양측 준비 완료! 방장이 "대국 시작"을 눌러주세요.';
      }
    }
  }

  // Render board
  renderOmBoard(room);

  // Render move list
  renderOmMoveHistory(room.move_history || []);

  // Spectator list
  const specList = $('omSpectatorList');
  const specCount = $('omSpectatorCount');
  const spectators = room.spectators || [];
  if (specCount) specCount.textContent = spectators.length;
  if (specList) {
    if (spectators.length === 0) {
      specList.innerHTML = '<span style="font-size:12px;color:var(--om-muted);opacity:0.6;">관전자가 없습니다.</span>';
    } else {
      specList.innerHTML = spectators.map(s => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:12px;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.04);">
          <div style="display:flex;align-items:center;gap:5px;min-width:0;">
            <span style="font-size:11px;flex-shrink:0;">👁️</span>
            <span style="color:var(--om-text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</span>
          </div>
          <span class="record-badge">${getOmStatText(s.id)}</span>
        </div>
      `).join('');
    }
  }

  // Update clocks
  startOmClock(room);
}

function renderOmBoard(room) {
  const svg = $('omBoardSvg');
  const layer = $('omIntersectionsLayer');
  const box = $('omBoardBox');
  if (!svg || !layer) return;

  const width = (box && box.clientWidth) ? box.clientWidth : 532;
  const height = (box && box.clientHeight) ? box.clientHeight : 532;
  const step = 35;
  const gridSpan = 14 * step; // 490px
  const padX = Math.max(0, (width - gridSpan) / 2);
  const padY = Math.max(0, (height - gridSpan) / 2);

  const getPt = (c, r) => ({
    x: padX + c * step,
    y: padY + r * step
  });

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // Render SVG Grid Lines (15 files x 15 ranks)
  let lines = '';
  for (let i = 0; i < 15; i++) {
    const p1 = getPt(i, 0);
    const p2 = getPt(i, 14);
    lines += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#3b2314" stroke-width="1.2" />`;

    const h1 = getPt(0, i);
    const h2 = getPt(14, i);
    lines += `<line x1="${h1.x}" y1="${h1.y}" x2="${h2.x}" y2="${h2.y}" stroke="#3b2314" stroke-width="1.2" />`;
  }

  // 5 Star points (화점) at (3,3), (11,3), (7,7), (3,11), (11,11)
  const starPoints = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
  for (const [sc, sr] of starPoints) {
    const sp = getPt(sc, sr);
    lines += `<circle cx="${sp.x}" cy="${sp.y}" r="3.5" fill="#3b2314" />`;
  }

  svg.innerHTML = lines;

  // History preview: reconstruct stones from move_history slice
  const isHistoryPreview = omHistoryPreviewIndex !== null;
  if (box) box.classList.toggle('review-mode', isHistoryPreview);
  let stones, lastMove, effectiveIsMyTurn;
  if (isHistoryPreview) {
    const histSlice = (room.move_history || []).slice(0, omHistoryPreviewIndex + 1);
    stones = histSlice.map(m => ({ col: m.col, row: m.row, color: m.player }));
    const lastEntry = histSlice[histSlice.length - 1];
    lastMove = lastEntry ? [lastEntry.col, lastEntry.row] : null;
    effectiveIsMyTurn = false;
  } else {
    stones = room.board?.stones || [];
    lastMove = room.last_move;
    effectiveIsMyTurn = (room.game_started && !room.result && myColor && room.active_turn === myColor);
  }

  // Render Intersections and Stones
  layer.innerHTML = '';
  const stoneMap = {};
  stones.forEach(s => { stoneMap[`${s.col},${s.row}`] = s.color; });

  const winningLineSet = new Set(
    (!isHistoryPreview ? (room.result?.winning_line || []) : []).map(pt => `${pt[0]},${pt[1]}`)
  );

  const foulMove = !isHistoryPreview ? room.result?.foul_move : null;
  const isFoulStone = (c, r) => foulMove && foulMove[0] === c && foulMove[1] === r;

  const canSeeForbidden = (myColor === 'b' || myColor === null);

  const forbiddenMap = {};
  if (!isHistoryPreview && room.active_turn === 'b' && !room.result) {
    (room.board?.forbidden_points || []).forEach(f => {
      forbiddenMap[`${f.col},${f.row}`] = f.type;
    });
  }

  for (let c = 0; c < 15; c++) {
    for (let r = 0; r < 15; r++) {
      const pt = getPt(c, r);
      const color = stoneMap[`${c},${r}`];
      const isLastMove = lastMove && lastMove[0] === c && lastMove[1] === r;
      const isWinningStone = winningLineSet.has(`${c},${r}`);
      const isFoul = isFoulStone(c, r);
      const foulType = forbiddenMap[`${c},${r}`];
      const showForbidden = canSeeForbidden && !!foulType;

      const ptDiv = document.createElement('div');
      ptDiv.className = `om-point ${isLastMove ? 'last-move' : ''} ${isWinningStone ? 'winning-stone' : ''} ${isFoul ? 'foul-stone' : ''} ${showForbidden ? 'forbidden' : ''}`;
      ptDiv.style.left = `${pt.x}px`;
      ptDiv.style.top = `${pt.y}px`;

      if (color) {
        const stoneDiv = document.createElement('div');
        stoneDiv.className = `om-stone ${color === 'b' ? 'black' : 'white'}`;
        ptDiv.appendChild(stoneDiv);
      } else {
        // Empty intersection
        if (!isHistoryPreview && showForbidden && room.active_turn === 'b') {
          const badge = document.createElement('span');
          badge.className = 'om-forbidden-marker';
          const foulLabel = foulType === '33' ? '3·3' : (foulType === '44' ? '4·4' : '6+');
          badge.textContent = foulLabel;
          badge.title = `흑 ${foulLabel} 금수 자리 (착수 시 백 자동승리)`;
          ptDiv.appendChild(badge);
        }

        if (effectiveIsMyTurn) {
          // Hover preview (Black can see preview-forbidden warning if hovering on a forbidden spot)
          ptDiv.addEventListener('mouseenter', () => {
            ptDiv.classList.add('hover-preview', myColor === 'b' ? 'preview-b' : 'preview-w');
            if (showForbidden && myColor === 'b') {
              ptDiv.classList.add('preview-forbidden');
            }
          });
          ptDiv.addEventListener('mouseleave', () => {
            ptDiv.classList.remove('hover-preview', 'preview-b', 'preview-w', 'preview-forbidden');
          });
        }
      }

      ptDiv.addEventListener('click', () => {
        if (!color && effectiveIsMyTurn) {
          if (foulType && myColor === 'b') {
            showOmFoulModal(c, r, foulType);
            return;
          }
          sendOmAction('move', { col: c, row: r });
          playStoneClickSound();
        }
      });

      layer.appendChild(ptDiv);
    }
  }
}

let pendingFoulMove = null;

function showOmFoulModal(col, row, foulType) {
  pendingFoulMove = { col, row };
  const modal = $('omFoulModal');
  const desc = $('omFoulModalDesc');
  if (!modal) return;

  const foulKorean = foulType === '33' ? '3-3(삼삼) 금수' : (foulType === '44' ? '4-4(사사) 금수' : '장목(6목 이상) 금수');
  if (desc) {
    desc.innerHTML = `해당 위치는 흑(黑) <b>[${foulKorean}]</b> 자리입니다.`;
  }
  modal.classList.remove('hidden');
}

function closeOmFoulModal() {
  pendingFoulMove = null;
  const modal = $('omFoulModal');
  if (modal) modal.classList.add('hidden');
}

function handleResign() {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (confirm('정말로 기권하시겠습니까?')) {
    sendOmAction('resign');
  }
}

function handleLeaveRoom() {
  if (!currentRoom) return;
  sendOmAction('leave_room');
  currentRoom = null;
  updateOmRoomState(null);
}

function renderOmMoveHistory(history) {
  const list = $('omMoveList');
  const countSpan = $('omMoveCount');
  if (countSpan) {
    countSpan.textContent = omHistoryPreviewIndex !== null ? `${omHistoryPreviewIndex + 1}/${history.length}` : `${history.length}`;
  }
  if (!list) return;

  if (!history.length) {
    list.innerHTML = '<div class="chess-empty-history">대국이 시작되면 기록됩니다.</div>';
    return;
  }
  list.innerHTML = history.map((item, idx) => {
    const isActive = omHistoryPreviewIndex === idx;
    return `
    <div class="chess-move-item${isActive ? ' active' : ''}" data-om-hist-idx="${idx}" style="padding:3px 8px;font-size:12px;cursor:pointer;">
      <span style="color:var(--om-muted);width:26px;">${idx + 1}.</span>
      <span style="color:${item.player === 'b' ? '#e4e4e7' : '#fef08a'};">${item.player === 'b' ? '⚫ 흑' : '⚪ 백'}</span>
      <span style="margin-left:6px;">(${item.col + 1}, ${item.row + 1})</span>
    </div>
  `;
  }).join('');

  list.querySelectorAll('[data-om-hist-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-om-hist-idx'), 10);
      jumpToOmHistory(idx);
    });
  });

  if (omHistoryPreviewIndex !== null) {
    const activeEl = list.querySelector('.chess-move-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    list.scrollTop = list.scrollHeight;
  }
}

function jumpToOmHistory(idx) {
  if (!currentRoom?.move_history) return;
  const clampedIdx = Math.max(0, Math.min(idx, currentRoom.move_history.length - 1));
  omHistoryPreviewIndex = clampedIdx;
  renderOmBoard(currentRoom);
  renderOmMoveHistory(currentRoom.move_history);
  updateOmReturnLiveBanner();
}

function clearOmHistoryPreview() {
  if (omHistoryPreviewIndex === null) return;
  omHistoryPreviewIndex = null;
  const box = $('omBoardBox');
  if (box) box.classList.remove('review-mode');
  renderOmBoard(currentRoom);
  renderOmMoveHistory(currentRoom?.move_history || []);
  updateOmReturnLiveBanner();
}

function updateOmReturnLiveBanner() {
  const btnReturnLive = $('omBtnReturnLive');
  const countSpan = $('omMoveCount');
  const isReviewing = omHistoryPreviewIndex !== null;
  const total = currentRoom?.move_history?.length || 0;

  if (btnReturnLive) btnReturnLive.classList.toggle('hidden', !isReviewing);
  if (countSpan) {
    countSpan.textContent = isReviewing ? `${omHistoryPreviewIndex + 1}/${total}` : `${total}`;
  }
}

function startOmClock(room) {
  if (clockInterval) clearInterval(clockInterval);
  if (!room.game_started || room.result) return;

  const updateTimers = () => {
    const now = Date.now() / 1000;
    const turn = room.active_turn;
    const clock = room.clock || {};

    let bRemain = clock.b_remain || 0;
    let wRemain = clock.w_remain || 0;

    if (turn === 'b' && clock.b_deadline) {
      bRemain = Math.max(0, clock.b_deadline - now);
    } else if (turn === 'w' && clock.w_deadline) {
      wRemain = Math.max(0, clock.w_deadline - now);
    }

    const fmt = s => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    if ($('omBlackTimer')) $('omBlackTimer').textContent = fmt(bRemain);
    if ($('omWhiteTimer')) $('omWhiteTimer').textContent = fmt(wRemain);
  };

  updateTimers();
  clockInterval = setInterval(updateTimers, 500);
}

function resetOmChat() {
  const container = $('omChatMessages');
  if (!container) return;
  container.innerHTML = '<div class="chess-chat-notice">실시간 대화창입니다.</div>';
}

function appendOmChat(sender, text, timeStr) {
  const container = $('omChatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chess-chat-item';
  div.innerHTML = `
    <span class="chess-chat-time" style="color:var(--om-muted);">${timeStr}</span>
    <span class="chess-chat-sender" style="color:#fde68a;font-weight:600;">${sender}:</span>
    <span class="chess-chat-body">${text}</span>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
