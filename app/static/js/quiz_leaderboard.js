// ============================================================
// Quiz Leaderboard Submodule: Rankings, Podiums & Badges
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';

export let currentLeaderboardPeriod = 'weekly';
export let currentLeaderboardCategory = '';

export async function fetchLeaderboard(period = 'weekly', category = '') {
  const leaderboardTbody = document.getElementById('leaderboard-tbody');
  const lbPeriodButtons = document.querySelectorAll('.lb-period-btn');
  const subjectSelect = document.getElementById('cbt-subject-lb-select');
  if (!leaderboardTbody) return;
  currentLeaderboardPeriod = period;
  currentLeaderboardCategory = category || '';

  if (category) {
    lbPeriodButtons.forEach(b => b.classList.remove('active'));
    if (subjectSelect) subjectSelect.value = category;
  } else {
    lbPeriodButtons.forEach(b => b.classList.toggle('active', b.dataset.period === period));
    if (subjectSelect) subjectSelect.value = '';
  }

  try {
    const url = category
      ? `/api/quiz/leaderboard?category=${encodeURIComponent(category)}`
      : `/api/quiz/leaderboard?period=${period}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('리더보드를 불러오지 못했습니다.');
    const data = await res.json();
    renderLeaderboard(data.leaderboard || [], category);
  } catch (err) {
    showToast(err.message || '리더보드 조회 실패', 'error');
  }
}

export function handleLeaderboardInvalidated() {
  const activeNav = document.querySelector('.quiz-nav-btn.active')?.dataset.nav;
  if (activeNav === 'leaderboard') {
    fetchLeaderboard(currentLeaderboardPeriod, currentLeaderboardCategory);
  }
}

export function renderLeaderboard(list, category = '') {
  const leaderboardPodium = document.getElementById('leaderboard-podium');
  const leaderboardTbody = document.getElementById('leaderboard-tbody');
  const thScore = document.getElementById('th-lb-score');
  const thCorrect = document.getElementById('th-lb-correct');
  const thStreak = document.getElementById('th-lb-streak');

  if (!leaderboardPodium || !leaderboardTbody) return;
  leaderboardPodium.replaceChildren();
  leaderboardTbody.replaceChildren();

  const isSubject = Boolean(category);

  if (thScore) thScore.textContent = '점수';
  if (thCorrect) thCorrect.textContent = '정답수';
  if (thStreak) thStreak.textContent = isSubject ? '칭호' : 'STREAK';

  const myUserId = state.currentUser ? Number(state.currentUser.id) : null;

  const top3 = list.slice(0, 3);
  const podiumIcons = ['🥇', '🥈', '🥉'];
  top3.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = `podium-card rank-${idx + 1}`;
    const icon = document.createElement('span');
    icon.className = 'podium-rank-icon';
    icon.textContent = podiumIcons[idx];
    const name = document.createElement('strong');
    name.className = 'podium-name';
    name.textContent = item.display_name || item.username;

    if (item.badge) {
      const badgeSpan = document.createElement('span');
      badgeSpan.className = `quiz-user-badge badge-${item.badge.type || 'subject'}`;
      badgeSpan.textContent = `${item.badge.icon} ${item.badge.label}`;
      badgeSpan.title = item.badge.title || '';
      name.append(' ', badgeSpan);
    } else if (item.current_streak >= 3) {
      const fire = document.createElement('span');
      fire.className = 'quiz-fire-badge';
      fire.textContent = '🔥 꾸준러';
      name.append(' ', fire);
    }

    const score = document.createElement('span');
    score.className = 'podium-score';
    score.textContent = `${item.score || 0}점`;

    const subText = document.createElement('small');
    subText.className = 'field-hint';
    if (isSubject) {
      subText.textContent = item.correct_count ? `${item.correct_count}문제 정답` : '';
    } else {
      subText.textContent = item.current_streak ? `🔥 STREAK ${item.current_streak}` : '';
    }
    card.append(icon, name, score, subText);
    leaderboardPodium.appendChild(card);
  });

  if (list.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = '<td colspan="5" style="text-align:center; padding: 24px; color: #64748b;">아직 퀴즈 제출 기록이 없습니다. 오늘의 첫 1위에 도전해보세요!</td>';
    leaderboardTbody.appendChild(emptyRow);
    return;
  }

  list.forEach(item => {
    const tr = document.createElement('tr');
    if (Number(item.user_id) === myUserId) tr.className = 'my-row';

    const tdRank = document.createElement('td');
    tdRank.innerHTML = `<strong>#${item.rank}</strong>`;

    const tdUser = document.createElement('td');
    const uName = item.display_name || item.username;
    tdUser.textContent = uName + (Number(item.user_id) === myUserId ? ' (나)' : '');
    if (item.badge) {
      const badgeSpan = document.createElement('span');
      badgeSpan.className = `quiz-user-badge badge-${item.badge.type || 'subject'}`;
      badgeSpan.textContent = `${item.badge.icon} ${item.badge.label}`;
      badgeSpan.title = item.badge.title || '';
      tdUser.append(' ', badgeSpan);
    } else if (item.current_streak >= 3) {
      const fire = document.createElement('span');
      fire.className = 'quiz-fire-badge';
      fire.textContent = '🔥 꾸준러';
      tdUser.append(' ', fire);
    }

    const tdScore = document.createElement('td');
    tdScore.innerHTML = `<strong style="color: #60a5fa;">${item.score || 0}점</strong>`;

    const tdCorrect = document.createElement('td');
    tdCorrect.textContent = `${item.correct_count || 0}문제`;

    const tdStreak = document.createElement('td');
    if (isSubject) {
      tdStreak.textContent = item.badge ? `${item.badge.icon} ${item.badge.label}` : '-';
    } else {
      tdStreak.textContent = item.current_streak ? `${item.current_streak}일 연속 🔥` : '-';
    }

    tr.append(tdRank, tdUser, tdScore, tdCorrect, tdStreak);
    leaderboardTbody.appendChild(tr);
  });
}
