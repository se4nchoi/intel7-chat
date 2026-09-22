// ============================================================
// BambooChat - Othello (Reversi - 오셀로) Module
// Native ES Module Architecture
// ============================================================

import { state } from './state.js';
import { showToast, escapeHtml } from './utils.js';
import { getAudioContext } from './audio.js';

const sameUser = (left, right) => left != null && right != null && String(left) === String(right);

let othWs = null;
let currentRoom = null;
let myColor = null; // 'b', 'w', or null
let othHistoryPreviewIndex = null;
let clockInterval = null;
let lastResultKeyHandled = null;
let previousDiscsMap = {}; // key -> color, used for flip animations

const $ = id => document.getElementById(id);

// Stone clack sound effect via Web Audio API
function playStoneClickSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.05);

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

export function initOthelloListeners() {
  window.bambooOthelloHook = {
    onTabActive: () => {
      ensureOthelloConnected();
      fetchOthelloRooms();
    }
  };

  // Lobby tabs
  const tabRooms = $('othTabRooms');
  const tabRank = $('othTabRank');
  const btnRefreshLobby = $('othBtnRefreshLobby');
  const btnRefreshRank = $('othBtnRefreshRank');
  const btnOpenCreate = $('othBtnOpenCreate');
  const btnCancelCreate = $('othBtnCancelCreate');
  const btnSubmitCreate = $('othBtnSubmitCreate');

  if (tabRooms) tabRooms.addEventListener('click', () => switchOthLobbyTab('rooms'));
  if (tabRank) tabRank.addEventListener('click', () => switchOthLobbyTab('rank'));
  if (btnRefreshLobby) btnRefreshLobby.addEventListener('click', fetchOthelloRooms);
  if (btnRefreshRank) btnRefreshRank.addEventListener('click', fetchOthelloRankings);

  if (btnOpenCreate) {
    btnOpenCreate.addEventListener('click', () => {
      $('othCreatePanel').classList.toggle('hidden');
      $('othCreateTitle').focus();
    });
  }
  if (btnCancelCreate) {
    btnCancelCreate.addEventListener('click', () => $('othCreatePanel').classList.add('hidden'));
  }
  if (btnSubmitCreate) {
    btnSubmitCreate.addEventListener('click', submitCreateOthRoom);
  }

  // Game screen actions
  const btnResign = $('othBtnResign');
  const btnLeave = $('othBtnLeave');
  const btnSitBlack = $('othBtnSitBlack');
  const btnSitWhite = $('othBtnSitWhite');
  const btnStartGame = $('othBtnStartGame');
  const btnReady = $('othBtnReady');
  const btnReturnToSpec = $('othBtnReturnToSpec');

  if (btnResign) btnResign.addEventListener('click', handleResign);
  if (btnLeave) btnLeave.addEventListener('click', handleLeaveRoom);
  if (btnSitBlack) btnSitBlack.addEventListener('click', () => sendOthAction('pick_role', { role: 'b' }));
  if (btnSitWhite) btnSitWhite.addEventListener('click', () => sendOthAction('pick_role', { role: 'w' }));
  if (btnReady) btnReady.addEventListener('click', () => sendOthAction('toggle_ready'));
  if (btnReturnToSpec) btnReturnToSpec.addEventListener('click', () => sendOthAction('pick_role', { role: 'spectator' }));
  if (btnStartGame) btnStartGame.addEventListener('click', () => sendOthAction('start_game'));

  const btnReturnLive = $('othBtnReturnLive');
  if (btnReturnLive) btnReturnLive.addEventListener('click', clearOthHistoryPreview);

  // Room chat
  const chatForm = $('othChatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('othChatInput');
      const text = (input?.value || '').trim();
      if (!text || !currentRoom) return;
      sendOthAction('chat', { text });
      input.value = '';
    });
  }
}

function ensureOthelloConnected() {
  if (othWs && (othWs.readyState === WebSocket.OPEN || othWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  othWs = new WebSocket(`${protocol}//${window.location.host}/ws/othello`);

  othWs.onopen = () => {
    fetchOthelloRooms();
  };

  othWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleOthMessage(msg);
    } catch (e) {
      console.error('[Othello] Failed to parse message', e);
    }
  };

  othWs.onclose = () => {
    othWs = null;
  };
}

function sendOthAction(action, data = {}) {
  ensureOthelloConnected();
  if (!othWs || othWs.readyState !== WebSocket.OPEN) {
    return;
  }
  const payload = { action, ...data };
  if (currentRoom) {
    payload.room_id = currentRoom.id;
  }
  othWs.send(JSON.stringify(payload));
}

function switchOthLobbyTab(tab) {
  const tabRooms = $('othTabRooms');
  const tabRank = $('othTabRank');
  const grid = $('othRoomGrid');
  const empty = $('othLobbyEmpty');
  const rankPanel = $('othRankingsPanel');
  const actionsRooms = $('othLobbyActionsRooms');
  const actionsRank = $('othLobbyActionsRank');

  $('othCreatePanel')?.classList.add('hidden');

  if (tab === 'rooms') {
    tabRooms?.classList.add('active');
    tabRank?.classList.remove('active');
    grid?.classList.remove('hidden');
    rankPanel?.classList.add('hidden');
    actionsRooms?.classList.remove('hidden');
    actionsRank?.classList.add('hidden');
    fetchOthelloRooms();
  } else {
    tabRooms?.classList.remove('active');
    tabRank?.classList.add('active');
    grid?.classList.add('hidden');
    empty?.classList.add('hidden');
    rankPanel?.classList.remove('hidden');
    actionsRooms?.classList.add('hidden');
    actionsRank?.classList.remove('hidden');
    fetchOthelloRankings();
  }
}

function fetchOthelloRooms() {
  sendOthAction('list_rooms');
}

async function fetchOthelloRankings() {
  try {
    const res = await fetch('/api/othello/rankings');
    if (!res.ok) throw new Error('랭킹 로드 실패');
    const data = await res.json();
    renderOthRankings(data.leaderboard || data.rankings || []);
  } catch (e) {
    showToast('오셀로 랭킹을 불러올 수 없습니다.', 'warning');
  }
}

function renderOthRankings(rankings) {
  const podium = $('othPodiumRow');
  const tbody = $('othRankingsTbody');
  if (!tbody) return;

  if (podium) {
    podium.replaceChildren();
    const top3 = rankings.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    top3.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = `podium-card rank-${idx + 1}`;
      const badgeHtml = item.badge
        ? `<span class="quiz-user-badge badge-othello" style="font-size:10.5px;margin-top:2px;">${item.badge.icon} ${escapeHtml(item.badge.label)}</span>`
        : '';
      card.innerHTML = `
        <span class="podium-rank-icon">${medals[idx]}</span>
        <span class="podium-name">${escapeHtml(item.display_name || item.username)}</span>
        ${badgeHtml}
        <span class="podium-score">${item.wins || 0}승</span>
        <span class="podium-sub">승률 ${item.win_rate || 0}% · ${item.wins || 0}승 ${item.draws || 0}무 ${item.losses || 0}패</span>
      `;
      podium.appendChild(card);
    });
  }

  if (!tbody) return;

  if (rankings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--oth-muted);">등록된 오셀로 전적이 없습니다. 첫 승리를 거두어보세요!</td></tr>';
    return;
  }

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;
  const rankMedals = { 1: '🥇 1', 2: '🥈 2', 3: '🥉 3' };

  tbody.innerHTML = rankings.map(r => {
    const isMe = sameUser(r.user_id, myUserId);
    const myRowClass = isMe ? ' class="my-row"' : '';
    const meLabel = isMe ? '<span style="font-size:10.5px;color:var(--oth-rose-soft);margin-left:4px;font-weight:700;">(나)</span>' : '';
    const badgeHtml = r.badge
      ? `<span class="quiz-user-badge badge-othello" style="font-size:10px;margin-left:4px;">${r.badge.icon} ${escapeHtml(r.badge.label)}</span>`
      : '';
    const lastWin = r.last_win_at ? String(r.last_win_at).slice(0, 16).replace('T', ' ') : '-';
    const rankDisplay = rankMedals[r.rank] || r.rank;

    return `
      <tr${myRowClass}>
        <td style="text-align:center;font-weight:700;color:var(--oth-rose-soft);">${rankDisplay}</td>
        <td style="font-weight:600;">
          <span style="color:var(--oth-text);">${escapeHtml(r.display_name || r.username)}</span>${badgeHtml}${meLabel}
        </td>
        <td style="text-align:center;font-weight:700;color:var(--oth-rose-light);">${r.wins}승</td>
        <td style="text-align:center;">${r.win_rate}%</td>
        <td style="text-align:center;color:var(--oth-muted);">${r.wins}승 ${r.draws || 0}무 ${r.losses || 0}패</td>
        <td style="text-align:center;color:var(--oth-muted);font-size:11.5px;">${lastWin}</td>
      </tr>
    `;
  }).join('');
}

function submitCreateOthRoom() {
  const titleInput = $('othCreateTitle');
  const timeInput = $('othCreateTime');
  const title = (titleInput?.value || '').trim();
  const timeMinutes = parseInt(timeInput?.value || '10', 10);

  sendOthAction('create_room', { title, time_minutes: timeMinutes });
  $('othCreatePanel')?.classList.add('hidden');
  if (titleInput) titleInput.value = '';
}

function handleResign() {
  if (!currentRoom || !currentRoom.game_started || currentRoom.result) return;
  if (!confirm('정말로 기권하시겠습니까? 상대방의 승리로 기록됩니다.')) return;
  sendOthAction('resign');
}

function handleLeaveRoom() {
  if (currentRoom) {
    if (currentRoom.game_started && !currentRoom.result && myColor) {
      if (!confirm('대국 도중 퇴장하면 기권패로 처리됩니다. 퇴장하시겠습니까?')) return;
    }
    sendOthAction('leave_room', { room_id: currentRoom.id });
  }
  currentRoom = null;
  myColor = null;
  othHistoryPreviewIndex = null;
  stopOthClock();
  showOthLobbyScreen();
  fetchOthelloRooms();
}

function handleOthMessage(msg) {
  if (msg.type === 'lobby_update') {
    renderOthLobbyRooms(msg.rooms || []);
  } else if (msg.type === 'room_state') {
    handleOthRoomState(msg.room, msg.server_now);
  } else if (msg.type === 'chat') {
    appendOthChatMessage(msg);
  } else if (msg.type === 'error') {
    showToast(msg.message || '오류가 발생했습니다.', 'warning');
  }
}

function renderOthLobbyRooms(rooms) {
  const grid = $('othRoomGrid');
  const empty = $('othLobbyEmpty');
  if (!grid) return;

  if (rooms.length === 0) {
    grid.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  grid.innerHTML = rooms.map(room => {
    const isPlaying = room.game_started && !room.result;
    const bName = room.black || '<span style="color:var(--oth-muted);opacity:0.6;">(비어있음)</span>';
    const wName = room.white || '<span style="color:var(--oth-muted);opacity:0.6;">(비어있음)</span>';
    const specCount = room.spectator_count || 0;

    return `
      <div class="oth-room-card" data-room-id="${room.id}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="font-weight:700;font-size:14px;color:var(--oth-rose-light);">${escapeHtml(room.title)}</div>
          <span class="chess-live-pill" style="${isPlaying ? 'background:rgba(244,63,94,0.2);color:#fda4af;' : 'background:rgba(255,255,255,0.06);color:var(--oth-muted);'}">
            ${isPlaying ? '<span class="pulse-dot"></span>진행 중' : '대기 중'}
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--oth-muted);">
          <div>⚫ 흑: <b>${bName}</b></div>
          <div>⚪ 백: <b>${wName}</b></div>
          <div style="font-size:11px;opacity:0.75;">⏱️ ${room.time_minutes}분 · 👥 관전자 ${specCount}명</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="oth-btn-primary btn-join-oth-room" data-room-id="${room.id}" style="flex:1;" type="button">대국실 입장</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.btn-join-oth-room').forEach(btn => {
    btn.addEventListener('click', () => {
      const rId = btn.getAttribute('data-room-id');
      if (rId) {
        sendOthAction('join_room', { room_id: rId });
      }
    });
  });
}

function showOthGameScreen() {
  $('othLobbyScreen')?.classList.add('hidden');
  $('othGameScreen')?.classList.remove('hidden');
}

function showOthLobbyScreen() {
  $('othGameScreen')?.classList.add('hidden');
  $('othLobbyScreen')?.classList.remove('hidden');
}

function handleOthRoomState(room, serverNow) {
  if (!room) return;
  currentRoom = room;
  showOthGameScreen();

  // Determine role
  const uid = state.currentUser?.id;
  if (room.black && sameUser(room.black.id, uid)) {
    myColor = 'b';
  } else if (room.white && sameUser(room.white.id, uid)) {
    myColor = 'w';
  } else {
    myColor = null;
  }

  // Header meta
  const titleEl = $('othRoomTitle');
  if (titleEl) titleEl.textContent = room.title || '오셀로 대국실';
  const badgeEl = $('othRoomIdBadge');
  if (badgeEl) badgeEl.textContent = `#${room.id.replace('othello-', '')}`;

  // Update Player Cards
  const bNameEl = $('othBlackName');
  if (bNameEl) bNameEl.textContent = room.black ? (room.black.name || room.black.username) : '흑 플레이어 대기 중';
  const wNameEl = $('othWhiteName');
  if (wNameEl) wNameEl.textContent = room.white ? (room.white.name || room.white.username) : '백 플레이어 대기 중';

  const getOthStatText = (userId) => {
    if (!userId || !room.stats || !room.stats[String(userId)]) return '0승 0패';
    const st = room.stats[String(userId)];
    return `${st.wins || 0}승 ${st.losses || 0}패`;
  };

  const blackStatBadge = $('othBlackBadge');
  if (blackStatBadge) {
    blackStatBadge.classList.toggle('hidden', !room.black);
    blackStatBadge.textContent = room.black ? getOthStatText(room.black.id) : '';
  }

  const whiteStatBadge = $('othWhiteBadge');
  if (whiteStatBadge) {
    whiteStatBadge.classList.toggle('hidden', !room.white);
    whiteStatBadge.textContent = room.white ? getOthStatText(room.white.id) : '';
  }

  const blackReadyBadge = $('othBlackReadyBadge');
  if (blackReadyBadge) {
    blackReadyBadge.classList.toggle('hidden', !room.black);
    blackReadyBadge.className = 'chess-ready-badge ' + (room.black_ready ? 'is-ready' : 'not-ready');
    blackReadyBadge.textContent = room.black_ready ? 'READY' : '대기 중';
  }
  const whiteReadyBadge = $('othWhiteReadyBadge');
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

  const btnReady = $('othBtnReady');
  if (btnReady) {
    btnReady.classList.toggle('hidden', !(isPlayer && isWaiting));
    if (isMyReady) {
      btnReady.textContent = '❌ 준비 취소';
      btnReady.className = 'oth-btn-ghost';
    } else {
      btnReady.textContent = '✅ 준비';
      btnReady.className = 'oth-btn-primary';
    }
  }

  const btnReturn = $('othBtnReturnToSpec');
  if (btnReturn) {
    btnReturn.classList.toggle('hidden', !(isPlayer && isWaiting));
  }

  const btnStart = $('othBtnStartGame');
  if (btnStart) {
    btnStart.classList.toggle('hidden', !(isOwner && isWaiting));
    btnStart.disabled = !isBothReady;
    if (!isBothReady) {
      if (!room.black_ready && !room.white_ready) btnStart.textContent = '⏳ 양측 준비 대기 중';
      else if (!room.black_ready) btnStart.textContent = '⏳ 흑(Black) 준비 대기 중';
      else btnStart.textContent = '⏳ 백(White) 준비 대기 중';
    } else {
      btnStart.textContent = '⚔️ 오셀로 대국 시작';
    }
  }

  $('othBtnSitBlack')?.classList.toggle('hidden', !!room.black || room.game_started);
  $('othBtnSitWhite')?.classList.toggle('hidden', !!room.white || room.game_started);

  // Update Disc Counts & Score Bar
  const counts = room.board?.counts || { black: 2, white: 2, empty: 60 };
  const bCountEl = $('othBlackCount');
  if (bCountEl) bCountEl.textContent = counts.black;
  const wCountEl = $('othWhiteCount');
  if (wCountEl) wCountEl.textContent = counts.white;

  const totalDiscs = (counts.black + counts.white) || 4;
  const bPct = Math.round((counts.black / totalDiscs) * 100);
  const wPct = 100 - bPct;
  const barBlack = $('othScoreBarBlack');
  if (barBlack) barBlack.style.width = `${bPct}%`;
  const barWhite = $('othScoreBarWhite');
  if (barWhite) barWhite.style.width = `${wPct}%`;

  // Status banner
  if (room.result) {
    $('othStatusText').textContent = `대국 종료: ${room.result.desc || ''}`;
    $('othTurnBadge').classList.add('hidden');
    if (JSON.stringify(room.result) !== lastResultKeyHandled) {
      lastResultKeyHandled = JSON.stringify(room.result);
      const res = room.result;
      if (!res.winner) {
        showToast(`🤝 오셀로 무승부: ${res.desc || '무승부로 종료되었습니다.'}`, 'info');
      } else if (myColor) {
        if (res.winner === myColor) {
          showToast(`🎉 오셀로 승리! ${res.desc || '대국에서 승리하셨습니다.'}`, 'success');
        } else {
          showToast(`💀 오셀로 패배: ${res.desc || '대국에서 패배하였습니다.'}`, 'warning');
        }
      } else {
        const winnerName = res.winner === 'b' ? '흑(Black)' : '백(White)';
        showToast(`🟢 오셀로 대국 종료: ${winnerName} 승리 (${res.desc || ''})`, 'info');
      }
    }
  } else {
    lastResultKeyHandled = null;
    if (room.game_started) {
      $('othTurnBadge').classList.remove('hidden');
      $('othTurnText').textContent = `${room.active_turn === 'b' ? '흑(Black)' : '백(White)'} 차례`;
      $('othStatusText').textContent = `${room.move_history?.length || 0}수 진행 중`;
    } else {
      $('othTurnBadge').classList.add('hidden');
      if (!isBothSeated) {
        $('othStatusText').textContent = '상대 플레이어 착석을 기다리는 중입니다.';
      } else if (!isBothReady) {
        $('othStatusText').textContent = '양측 플레이어 준비(Ready)를 기다리는 중입니다.';
      } else {
        $('othStatusText').textContent = '👑 양측 준비 완료! 방장이 "대국 시작"을 눌러주세요.';
      }
    }
  }

  // Render board
  renderOthBoard(room);

  // Render move list
  renderOthMoveHistory(room.move_history || []);

  // Spectator list
  const specList = $('othSpectatorList');
  const specCount = $('othSpectatorCount');
  const spectators = room.spectators || [];
  if (specCount) specCount.textContent = spectators.length;
  if (specList) {
    if (spectators.length === 0) {
      specList.innerHTML = '<span style="font-size:11px;color:var(--oth-muted);opacity:0.6;">관전자가 없습니다.</span>';
    } else {
      specList.innerHTML = spectators.map(s => `
        <div style="display:flex;flex-direction:column;gap:1px;font-size:11.5px;padding:3px 5px;border-radius:4px;background:rgba(255,255,255,0.04);">
          <div style="display:flex;align-items:center;gap:4px;min-width:0;">
            <span style="font-size:10px;flex-shrink:0;">👁️</span>
            <span style="color:var(--oth-text);font-weight:600;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</span>
          </div>
          <span style="font-size:10px;color:var(--oth-muted);padding-left:14px;">${getOthStatText(s.id)}</span>
        </div>
      `).join('');
    }
  }

  // Update clocks
  startOthClock(room);
}

function renderOthBoard(room) {
  const inner = $('othBoardInner');
  const box = $('othBoardBox');
  if (!inner) return;

  const isHistoryPreview = othHistoryPreviewIndex !== null;
  if (box) box.classList.toggle('review-mode', isHistoryPreview);

  let discs, lastMove, effectiveIsMyTurn, legalMoves;

  if (isHistoryPreview) {
    // Reconstruct board at historical step
    discs = reconstructDiscsAtStep(room.move_history || [], othHistoryPreviewIndex);
    const histSlice = (room.move_history || []).slice(0, othHistoryPreviewIndex + 1);
    const lastEntry = histSlice[histSlice.length - 1];
    lastMove = (lastEntry && lastEntry.col >= 0) ? [lastEntry.col, lastEntry.row] : null;
    effectiveIsMyTurn = false;
    legalMoves = [];
  } else {
    discs = room.board?.discs || [];
    lastMove = room.last_move;
    effectiveIsMyTurn = (room.game_started && !room.result && myColor && room.active_turn === myColor);
    legalMoves = (effectiveIsMyTurn && room.board?.legal_moves) ? room.board.legal_moves : [];
  }

  // Disc lookup map
  const discMap = {};
  discs.forEach(d => {
    discMap[`${d.col},${d.row}`] = d.color;
  });

  const legalMap = {};
  legalMoves.forEach(lm => {
    legalMap[`${lm.col},${lm.row}`] = lm.flips;
  });

  // Track flips for animation
  const newDiscsMap = { ...discMap };

  // Render 8x8 cells
  inner.innerHTML = '';

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'oth-cell';
      cell.dataset.col = c;
      cell.dataset.row = r;

      const color = discMap[`${c},${r}`];
      const isLast = lastMove && lastMove[0] === c && lastMove[1] === r;
      if (isLast) cell.classList.add('last-move');

      if (color) {
        const wrap = document.createElement('div');
        wrap.className = 'oth-disc-wrap';

        const disc = document.createElement('div');
        disc.className = `oth-disc ${color === 'b' ? 'black' : 'white'}`;

        // Check if just flipped
        const prevColor = previousDiscsMap[`${c},${r}`];
        if (prevColor && prevColor !== color && !isHistoryPreview) {
          disc.classList.add('flipped-anim');
        }

        wrap.appendChild(disc);
        cell.appendChild(wrap);
      } else if (effectiveIsMyTurn && legalMap[`${c},${r}`] !== undefined) {
        // Legal move destination
        cell.classList.add('legal-target');
        const flips = legalMap[`${c},${r}`];
        const hint = document.createElement('div');
        hint.className = 'oth-legal-hint';
        hint.title = `착수 시 ${flips}개 뒤집음`;
        cell.appendChild(hint);

        cell.addEventListener('click', () => {
          sendOthAction('move', { col: c, row: r });
          playStoneClickSound();
        });
      }

      inner.appendChild(cell);
    }
  }

  // 4 Star Dots at c3 (2,2), f3 (5,2), c6 (2,5), f6 (5,5) - placed at the corner intersections
  // In an 8x8 grid, lines fall at multiples of 12.5% (1/8):
  // Intersection after row 2 is 25% (or between c/d: 37.5% etc.)
  // Official WOF star dots are at (c3, c6, f3, f6), i.e., after columns 2 & 6, rows 2 & 6:
  // (col 2, row 2) bottom-right corner -> 25% X, 25% Y, etc.
  const starCoords = [
    { x: '25%', y: '25%' },
    { x: '75%', y: '25%' },
    { x: '25%', y: '75%' },
    { x: '75%', y: '75%' },
  ];
  starCoords.forEach(pos => {
    const dot = document.createElement('div');
    dot.className = 'oth-star-dot';
    dot.style.left = pos.x;
    dot.style.top = pos.y;
    inner.appendChild(dot);
  });

  if (!isHistoryPreview) {
    previousDiscsMap = newDiscsMap;
  }
}

function reconstructDiscsAtStep(history, stepIndex) {
  // Start from standard initial setup
  const grid = {
    '3,3': 'w',
    '4,4': 'w',
    '3,4': 'b',
    '4,3': 'b',
  };

  for (let i = 0; i <= stepIndex && i < history.length; i++) {
    const m = history[i];
    if (m.col >= 0 && m.row >= 0) {
      grid[`${m.col},${m.row}`] = m.player;
      if (m.flipped) {
        m.flipped.forEach(pt => {
          grid[`${pt[0]},${pt[1]}`] = m.player;
        });
      }
    }
  }

  return Object.entries(grid).map(([coord, color]) => {
    const [col, row] = coord.split(',').map(Number);
    return { col, row, color };
  });
}

function renderOthMoveHistory(history) {
  const list = $('othMoveList');
  const countEl = $('othMoveCount');
  if (!list) return;

  if (countEl) countEl.textContent = history.length;

  if (history.length === 0) {
    list.innerHTML = '<div class="chess-empty-history">대국이 시작되면 기록됩니다.</div>';
    return;
  }

  list.innerHTML = history.map((m, idx) => {
    const isPass = m.passed && (m.col < 0 || m.col === undefined);
    const pIcon = m.player === 'b' ? '⚫' : '⚪';
    const text = isPass ? `${pIcon} [패스]` : `${pIcon} ${m.notation || (m.col + ',' + m.row)} (${m.flipped ? m.flipped.length : 0}개)`;
    const isSelected = othHistoryPreviewIndex === idx;

    return `
      <div class="oth-move-item ${isSelected ? 'selected' : ''} ${isPass ? 'is-pass' : ''}" data-index="${idx}">
        <span>${idx + 1}. ${text}</span>
        ${m.counts ? `<span style="font-size:10.5px;opacity:0.7;">${m.counts.black}:${m.counts.white}</span>` : ''}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.oth-move-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.getAttribute('data-index'), 10);
      setOthHistoryPreview(idx);
    });
  });

  if (othHistoryPreviewIndex === null) {
    list.scrollTop = list.scrollHeight;
  }
}

function setOthHistoryPreview(index) {
  othHistoryPreviewIndex = index;
  $('othBtnReturnLive')?.classList.remove('hidden');
  if (currentRoom) {
    renderOthBoard(currentRoom);
    renderOthMoveHistory(currentRoom.move_history || []);
  }
}

function clearOthHistoryPreview() {
  othHistoryPreviewIndex = null;
  $('othBtnReturnLive')?.classList.add('hidden');
  if (currentRoom) {
    renderOthBoard(currentRoom);
    renderOthMoveHistory(currentRoom.move_history || []);
  }
}

function startOthClock(room) {
  stopOthClock();
  if (!room || !room.clock) return;

  const updateClocks = () => {
    const now = Date.now() / 1000;
    const bDeadline = room.clock.b_deadline;
    const wDeadline = room.clock.w_deadline;

    let bRemain = room.clock.b_remain;
    let wRemain = room.clock.w_remain;

    if (room.active_turn === 'b' && bDeadline && room.game_started && !room.result) {
      bRemain = Math.max(0, bDeadline - now);
    }
    if (room.active_turn === 'w' && wDeadline && room.game_started && !room.result) {
      wRemain = Math.max(0, wDeadline - now);
    }

    const fmt = sec => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    const bTimer = $('othBlackTimer');
    if (bTimer) bTimer.textContent = fmt(bRemain);
    const wTimer = $('othWhiteTimer');
    if (wTimer) wTimer.textContent = fmt(wRemain);
  };

  updateClocks();
  clockInterval = setInterval(updateClocks, 250);
}

function stopOthClock() {
  if (clockInterval) {
    clearInterval(clockInterval);
    clockInterval = null;
  }
}

function appendOthChatMessage(msg) {
  const container = $('othChatMessages');
  if (!container) return;

  const isSystem = !!msg.system;
  const item = document.createElement('div');
  item.className = 'chess-chat-item';

  if (isSystem) {
    item.innerHTML = `
      <div style="font-size:11.5px;color:var(--oth-rose-soft);font-weight:600;padding:2px 0;">
        📢 ${escapeHtml(msg.text)}
      </div>
    `;
  } else {
    item.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;">
        <span style="font-weight:700;color:var(--oth-rose-light);">${escapeHtml(msg.sender)}</span>
        <span style="color:var(--oth-muted);font-size:10px;">${msg.time || ''}</span>
      </div>
      <div style="font-size:12px;color:var(--oth-text);word-break:break-word;margin-top:1px;">
        ${escapeHtml(msg.text)}
      </div>
    `;
  }

  container.appendChild(item);
  container.scrollTop = container.scrollHeight;
}
