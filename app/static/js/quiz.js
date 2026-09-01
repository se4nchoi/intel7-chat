// ============================================================
// Quiz Module: CBT Portal, Quiz Runner, History Accordion & Leaderboard
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';

let todayQuizzes = [];
let currentQuizIndex = 0;
let userQuizStats = null;
let currentSelectedOption = null;
let currentQuizNav = 'daily';
let solvedHistoryQuizzes = [];
let currentHistoryFilter = 'all';

export function getCategoryIcon(catName = '') {
  const lower = catName.toLowerCase();
  if (lower.includes('plc') || lower.includes('시퀀스')) return '⚡';
  if (lower.includes('전기') || lower.includes('회로')) return '🔌';
  if (lower.includes('디지털') || lower.includes('전자')) return '⚙️';
  if (lower.includes('공압') || lower.includes('유압')) return '💨';
  if (lower.includes('cbt') || lower.includes('기출')) return '📜';
  return '📖';
}

export async function refreshQuizHeaderStreak() {
  if (!state.currentUser) return;
  const headerQuizStreak = document.getElementById('header-quiz-streak');
  const headerStreakCount = document.getElementById('header-streak-count');
  try {
    const res = await fetch('/api/quiz/stats');
    if (!res.ok) return;
    const data = await res.json();
    userQuizStats = data;
    if (headerQuizStreak && headerStreakCount) {
      const streak = data.current_streak || 0;
      if (streak > 0) {
        headerStreakCount.textContent = streak;
        headerQuizStreak.classList.remove('hidden');
      } else {
        headerQuizStreak.classList.add('hidden');
      }
    }
  } catch { /* ignore */ }
}

export async function refreshQuizSidebarCounts() {
  if (!state.currentUser) return;
  const sidebarCountWrong = document.getElementById('sidebar-count-wrong');
  const sidebarCountStarred = document.getElementById('sidebar-count-starred');
  const sidebarCountHistory = document.getElementById('sidebar-count-history');
  try {
    const res = await fetch('/api/quiz/sidebar-counts');
    if (!res.ok) return;
    const data = await res.json();
    if (sidebarCountWrong) sidebarCountWrong.textContent = String(data.wrong || 0);
    if (sidebarCountStarred) sidebarCountStarred.textContent = String(data.starred || 0);
    if (sidebarCountHistory) sidebarCountHistory.textContent = String(data.history || 0);
  } catch { /* ignore */ }
}

export async function fetchCategoriesSummary() {
  const quizSidebarCategoriesList = document.getElementById('quiz-sidebar-categories-list');
  if (!quizSidebarCategoriesList) return;
  try {
    const res = await fetch('/api/quiz/categories');
    if (!res.ok) return;
    const data = await res.json();
    const categories = data.categories || [];
    quizSidebarCategoriesList.replaceChildren();

    if (categories.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'field-hint';
      emptyDiv.style.padding = '6px 8px';
      emptyDiv.textContent = '등록된 주제 없음';
      quizSidebarCategoriesList.appendChild(emptyDiv);
      return;
    }

    categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cbt-nav-item${currentQuizNav === `category:${cat.category}` ? ' active' : ''}`;
      btn.dataset.nav = `category:${cat.category}`;

      const icon = document.createElement('span');
      icon.className = 'cbt-nav-icon';
      icon.textContent = getCategoryIcon(cat.category);

      const text = document.createElement('span');
      text.className = 'cbt-nav-text';
      text.textContent = cat.category;

      const count = document.createElement('span');
      count.className = 'cbt-sidebar-count-badge';
      count.textContent = String(cat.count || 0);

      btn.append(icon, text, count);
      btn.addEventListener('click', () => {
        switchQuizNav(`category:${cat.category}`, {
          title: `📚 ${cat.category}`,
          desc: `${cat.category} 분야의 핵심 퀴즈 문제입니다.`,
        });
      });
      quizSidebarCategoriesList.appendChild(btn);
    });
  } catch { /* ignore */ }
}

export function openQuizModal(nav = 'daily') {
  const quizModal = document.getElementById('quiz-modal');
  const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
  if (!quizModal || !state.currentUser) return;
  quizModal.classList.remove('hidden');
  if (quizNavAdminBtn) {
    quizNavAdminBtn.classList.toggle('hidden', state.currentUser?.role !== 'admin');
  }
  fetchCategoriesSummary();
  refreshQuizSidebarCounts();
  switchQuizNav(nav);
}

export function closeQuizModal() {
  const quizModal = document.getElementById('quiz-modal');
  if (quizModal) quizModal.classList.add('hidden');
}

export function switchQuizNav(navKey, meta = {}) {
  currentQuizNav = navKey;
  const isHistory = navKey === 'history';
  const isQuizRunner = navKey === 'daily' || navKey === 'random' || navKey.startsWith('category:') || navKey === 'wrong' || navKey === 'starred';
  const isLb = navKey === 'leaderboard';
  const isAdmin = navKey === 'admin';

  const quizTabDailyContent = document.getElementById('quiz-tab-daily-content');
  const quizTabHistoryContent = document.getElementById('quiz-tab-history-content');
  const quizTabLeaderboardContent = document.getElementById('quiz-tab-leaderboard-content');
  const quizTabAdminContent = document.getElementById('quiz-tab-admin-content');
  const cbtMainHeader = document.getElementById('cbt-main-header');
  const cbtProgressRow = document.getElementById('cbt-progress-row');
  const cbtCurrentTopicTitle = document.getElementById('cbt-current-topic-title');
  const cbtTopicDesc = document.getElementById('cbt-topic-desc');

  document.querySelectorAll('.cbt-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.nav === navKey);
  });

  quizTabDailyContent?.classList.toggle('hidden', !isQuizRunner);
  quizTabHistoryContent?.classList.toggle('hidden', !isHistory);
  quizTabLeaderboardContent?.classList.toggle('hidden', !isLb);
  quizTabAdminContent?.classList.toggle('hidden', !isAdmin);

  if (cbtMainHeader) cbtMainHeader.classList.toggle('hidden', isAdmin);
  if (cbtProgressRow) cbtProgressRow.classList.toggle('hidden', !isQuizRunner);

  const topicConfig = {
    daily: { title: '⚡ 오늘의 퀴즈', desc: '매일 엄선된 5개 문제를 풀고 연속 정답 스트릭을 달성하세요.' },
    random: { title: '🔀 전체 랜덤 퀴즈', desc: '전체 등록된 퀴즈에서 무작위로 추출된 5개 문제를 풉니다.' },
    wrong: { title: '❌ 오답 복습', desc: '이전에 틀렸던 문제를 다시 풀고 완전히 마스터해 보세요.' },
    starred: { title: '⭐ 중요 문제 보관함', desc: '풀이 중 별표(북마크)로 저장해 둔 핵심 문제들을 복습합니다.' },
    history: { title: '📜 내가 푼 문제', desc: '과목별로 풀이한 퀴즈 목록과 상세 해설을 확인하세요.' },
    leaderboard: { title: '🏆 학습 랭킹 순위표', desc: '일일/주간/전체 퀴즈 점수 및 연속 스트릭 순위입니다.' },
    admin: { title: '⚙️ 퀴즈 관리 센터', desc: '교재 PDF를 통한 AI 자동 출제 및 문제 목록을 관리합니다.' },
  };

  const currentCfg = topicConfig[navKey] || meta || { title: `📚 ${navKey.replace('category:', '')}`, desc: '해당 분야 집중 학습 퀴즈입니다.' };
  if (cbtCurrentTopicTitle) cbtCurrentTopicTitle.textContent = currentCfg.title || '퀴즈';
  if (cbtTopicDesc) cbtTopicDesc.textContent = currentCfg.desc || '';

  if (navKey === 'daily') {
    fetchTodayQuizzes(null);
  } else if (navKey === 'random') {
    fetchTodayQuizzes('random');
  } else if (navKey.startsWith('category:')) {
    const categoryName = navKey.replace('category:', '');
    fetchTodayQuizzes(categoryName);
  } else if (navKey === 'wrong' || navKey === 'starred') {
    fetchReviewQuizzes(navKey);
  } else if (isHistory) {
    fetchSolvedHistoryList();
  } else if (isLb) {
    fetchLeaderboard('weekly');
  } else if (isAdmin) {
    fetchAdminQuizzes();
  }
}

export async function fetchSolvedHistoryList() {
  if (!state.currentUser) return;
  const historyLoadingState = document.getElementById('history-loading-state');
  const historyEmptyState = document.getElementById('history-empty-state');
  const historyTopicAccordionList = document.getElementById('history-topic-accordion-list');

  historyLoadingState?.classList.remove('hidden');
  historyEmptyState?.classList.add('hidden');
  historyTopicAccordionList?.replaceChildren();

  try {
    const res = await fetch('/api/quiz/review?mode=history');
    if (!res.ok) throw new Error('풀이 이력을 불러오지 못했습니다.');
    const data = await res.json();
    solvedHistoryQuizzes = data.quizzes || [];
    renderSolvedHistoryAccordion();
  } catch (err) {
    if (historyEmptyState) {
      historyEmptyState.textContent = `❌ ${err.message || '이력을 불러오는 중 오류가 발생했습니다.'}`;
      historyEmptyState.classList.remove('hidden');
    }
  } finally {
    historyLoadingState?.classList.add('hidden');
  }
}

export function renderSolvedHistoryAccordion() {
  const historyTopicAccordionList = document.getElementById('history-topic-accordion-list');
  const historyTotalSummary = document.getElementById('history-total-summary');
  const historyEmptyState = document.getElementById('history-empty-state');
  if (!historyTopicAccordionList) return;
  historyTopicAccordionList.replaceChildren();

  let filtered = solvedHistoryQuizzes;
  if (currentHistoryFilter === 'correct') {
    filtered = filtered.filter(q => Boolean(q.is_correct));
  } else if (currentHistoryFilter === 'wrong') {
    filtered = filtered.filter(q => !q.is_correct);
  }

  const totalSolved = solvedHistoryQuizzes.length;
  const correctCount = solvedHistoryQuizzes.filter(q => Boolean(q.is_correct)).length;
  const wrongCount = totalSolved - correctCount;

  if (historyTotalSummary) {
    historyTotalSummary.textContent = `총 ${totalSolved}문제 풀이 완료 (⭕ ${correctCount}개 정답 / ❌ ${wrongCount}개 오답)`;
  }

  if (filtered.length === 0) {
    if (historyEmptyState) {
      historyEmptyState.textContent = currentHistoryFilter === 'all'
        ? '📜 아직 제출한 풀이 이력이 없습니다. 학습 모드에서 퀴즈를 풀어보세요!'
        : (currentHistoryFilter === 'correct' ? '맞힌 문제가 없습니다.' : '틀린 문제가 없습니다.');
      historyEmptyState.classList.remove('hidden');
    }
    return;
  }
  historyEmptyState?.classList.add('hidden');

  const grouped = {};
  filtered.forEach(q => {
    const cat = q.category || '기타';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(q);
  });

  Object.entries(grouped).forEach(([catName, list]) => {
    const groupCard = document.createElement('div');
    groupCard.className = 'cbt-history-topic-group';

    const groupCorrect = list.filter(q => Boolean(q.is_correct)).length;
    const groupWrong = list.length - groupCorrect;

    const header = document.createElement('div');
    header.className = 'cbt-history-topic-header';

    const titleArea = document.createElement('div');
    titleArea.className = 'cbt-topic-title-area';

    const chevron = document.createElement('span');
    chevron.className = 'cbt-topic-chevron';
    chevron.textContent = '▼';

    const icon = document.createElement('span');
    icon.className = 'cbt-topic-icon';
    icon.textContent = getCategoryIcon(catName);

    const name = document.createElement('strong');
    name.className = 'cbt-topic-name';
    name.textContent = `${catName} (${list.length}문제)`;

    titleArea.append(chevron, icon, name);

    const statsArea = document.createElement('div');
    statsArea.className = 'cbt-topic-stats';
    if (groupCorrect > 0) {
      const p = document.createElement('span');
      p.className = 'cbt-topic-stat-pill correct';
      p.textContent = `⭕ ${groupCorrect}`;
      statsArea.appendChild(p);
    }
    if (groupWrong > 0) {
      const p = document.createElement('span');
      p.className = 'cbt-topic-stat-pill wrong';
      p.textContent = `❌ ${groupWrong}`;
      statsArea.appendChild(p);
    }

    header.append(titleArea, statsArea);
    header.addEventListener('click', () => {
      groupCard.classList.toggle('collapsed');
    });

    const body = document.createElement('div');
    body.className = 'cbt-history-topic-body';

    list.forEach(q => {
      const item = document.createElement('div');
      item.className = 'cbt-history-item';

      const itemHeader = document.createElement('div');
      itemHeader.className = 'cbt-history-item-header';

      const left = document.createElement('div');
      left.className = 'cbt-hist-left';

      const statusIcon = document.createElement('span');
      statusIcon.className = `cbt-hist-status ${q.is_correct ? 'correct' : 'wrong'}`;
      statusIcon.textContent = q.is_correct ? '⭕' : '❌';

      const qTitle = document.createElement('span');
      qTitle.className = 'cbt-hist-q-title';
      qTitle.textContent = q.question;
      qTitle.title = q.question;

      left.append(statusIcon, qTitle);

      const right = document.createElement('div');
      right.className = 'cbt-hist-right';

      const meta = document.createElement('span');
      meta.className = 'cbt-hist-meta';
      const dateStr = q.submitted_at ? q.submitted_at.substring(0, 10) : '';
      meta.textContent = `${q.is_correct ? '+' + (q.score_earned || 20) + '점' : '0점'} · ${dateStr}`;

      const toggleArrow = document.createElement('span');
      toggleArrow.className = 'cbt-hist-toggle-arrow';
      toggleArrow.textContent = '▼';

      right.append(meta, toggleArrow);
      itemHeader.append(left, right);

      const detail = document.createElement('div');
      detail.className = 'cbt-history-item-detail';

      const detailQ = document.createElement('div');
      detailQ.className = 'cbt-hist-detail-q';
      detailQ.textContent = `Q. ${q.question}`;
      detail.appendChild(detailQ);

      if (q.image_filename) {
        const img = document.createElement('img');
        img.src = `/api/quiz/images/${encodeURIComponent(q.image_filename)}`;
        img.className = 'cbt-diagram-img';
        img.style.maxHeight = '180px';
        img.style.objectFit = 'contain';
        detail.appendChild(img);
      }

      const answersRow = document.createElement('div');
      answersRow.className = 'cbt-hist-answers-row';

      const myAns = document.createElement('div');
      myAns.className = 'cbt-hist-ans-item';
      myAns.innerHTML = `<strong>제출한 답안:</strong> <span class="user-ans ${q.is_correct ? 'correct' : 'wrong'}">${q.user_answer || '(미입력)'}</span>`;

      const correctAns = document.createElement('div');
      correctAns.className = 'cbt-hist-ans-item';
      const cText = Array.isArray(q.correct_answers) ? q.correct_answers.join(', ') : (q.correct_answers || '');
      correctAns.innerHTML = `<strong>올바른 정답:</strong> <span class="correct-ans">${cText}</span>`;

      answersRow.append(myAns, correctAns);
      detail.appendChild(answersRow);

      if (q.explanation) {
        const exp = document.createElement('div');
        exp.className = 'cbt-hist-explanation';
        exp.textContent = `💡 해설: ${q.explanation}`;
        if (q.source_ref) {
          const src = document.createElement('div');
          src.className = 'cbt-hist-source';
          src.textContent = `출처: ${q.source_ref}`;
          exp.appendChild(src);
        }
        detail.appendChild(exp);
      }

      itemHeader.addEventListener('click', () => {
        item.classList.toggle('open');
      });

      item.append(itemHeader, detail);
      body.appendChild(item);
    });

    groupCard.append(header, body);
    historyTopicAccordionList.appendChild(groupCard);
  });
}

export async function fetchTodayQuizzes(category = null) {
  if (!state.currentUser) return;
  const quizLoadingText = document.getElementById('quiz-loading-text');
  const quizLoadingState = document.getElementById('quiz-loading-state');
  const quizContainer = document.getElementById('quiz-container');

  if (quizLoadingText) quizLoadingText.textContent = '문제를 불러오는 중입니다...';
  quizLoadingState?.classList.remove('hidden');
  quizContainer?.classList.add('hidden');
  try {
    const url = category ? `/api/quiz/today?category=${encodeURIComponent(category)}` : '/api/quiz/today';
    const res = await fetch(url);
    if (!res.ok) throw new Error('퀴즈 목록을 불러오지 못했습니다.');
    const data = await res.json();
    todayQuizzes = data.quizzes || [];
    userQuizStats = data.stats || null;
    renderQuizStats();
    if (todayQuizzes.length > 0) {
      currentQuizIndex = 0;
      renderQuizPillNav();
      renderActiveQuiz();
      quizLoadingState?.classList.add('hidden');
      quizContainer?.classList.remove('hidden');
    } else {
      if (quizLoadingText) {
        quizLoadingText.textContent = category && category !== 'random'
          ? `선택한 주제 [${category}]에 등록된 문제가 없습니다.`
          : '현재 등록된 퀴즈가 없습니다.';
      }
    }
  } catch (err) {
    if (quizLoadingText) quizLoadingText.textContent = err.message || '오류가 발생했습니다.';
  }
}

export async function fetchReviewQuizzes(mode) {
  if (!state.currentUser) return;
  const quizLoadingText = document.getElementById('quiz-loading-text');
  const quizLoadingState = document.getElementById('quiz-loading-state');
  const quizContainer = document.getElementById('quiz-container');

  const modeLabels = {
    wrong: '오답 목록을',
    starred: '보관한 문제 목록을',
  };
  if (quizLoadingText) quizLoadingText.textContent = `${modeLabels[mode] || '문제를'} 불러오는 중입니다...`;
  quizLoadingState?.classList.remove('hidden');
  quizContainer?.classList.add('hidden');
  try {
    const res = await fetch(`/api/quiz/review?mode=${mode}`);
    if (!res.ok) throw new Error('목록을 불러오지 못했습니다.');
    const data = await res.json();
    todayQuizzes = data.quizzes || [];
    if (todayQuizzes.length > 0) {
      currentQuizIndex = 0;
      renderQuizPillNav();
      renderActiveQuiz();
      quizLoadingState?.classList.add('hidden');
      quizContainer?.classList.remove('hidden');
    } else {
      const emptyMsgs = {
        wrong: '🎉 오답 기록이 없습니다! 모든 문제를 완벽하게 맞히셨습니다.',
        starred: '⭐ 보관한 문제가 없습니다. 문제 상단의 ⭐ 버튼을 눌러 중요한 문제를 저장해 보세요.',
      };
      if (quizLoadingText) quizLoadingText.textContent = emptyMsgs[mode] || '해당되는 문제가 없습니다.';
    }
  } catch (err) {
    if (quizLoadingText) quizLoadingText.textContent = err.message || '오류가 발생했습니다.';
  }
}

export function renderQuizStats() {
  if (!userQuizStats) return;
  const quizStatStreak = document.getElementById('quiz-stat-streak');
  if (quizStatStreak) quizStatStreak.textContent = `${userQuizStats.current_streak || 0}일 연속`;
  refreshQuizHeaderStreak();
}

export function renderQuizPillNav() {
  const cbtProgressCount = document.getElementById('cbt-progress-count');
  const cbtProgressPercent = document.getElementById('cbt-progress-percent');
  const cbtProgressFill = document.getElementById('cbt-progress-fill');
  const quizPillNav = document.getElementById('quiz-pill-nav');
  const quizPrevBtn = document.getElementById('quiz-prev-btn');
  const quizNextBtn = document.getElementById('quiz-next-btn');

  const total = todayQuizzes.length || 1;
  const currentNum = currentQuizIndex + 1;
  const pct = Math.round((currentNum / total) * 100);

  if (cbtProgressCount) cbtProgressCount.textContent = `${currentNum} / ${total}`;
  if (cbtProgressPercent) cbtProgressPercent.textContent = `${pct}%`;
  if (cbtProgressFill) cbtProgressFill.style.width = `${pct}%`;

  if (quizPillNav) {
    quizPillNav.replaceChildren();
    todayQuizzes.forEach((q, idx) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `quiz-pill-btn${idx === currentQuizIndex ? ' active' : ''}`;
      if (q.is_solved) {
        pill.classList.add(q.is_correct ? 'solved-correct' : 'solved-wrong');
        pill.textContent = q.is_correct ? '✓' : '✕';
      } else {
        pill.textContent = String(idx + 1);
      }
      pill.addEventListener('click', () => {
        currentQuizIndex = idx;
        renderQuizPillNav();
        renderActiveQuiz();
      });
      quizPillNav.appendChild(pill);
    });
  }

  if (quizPrevBtn) quizPrevBtn.disabled = currentQuizIndex === 0;
  if (quizNextBtn) quizNextBtn.disabled = currentQuizIndex === todayQuizzes.length - 1;
}

export function renderActiveQuiz() {
  const q = todayQuizzes[currentQuizIndex];
  if (!q) return;

  const quizCategoryTag = document.getElementById('quiz-category-tag');
  const quizDifficultyTag = document.getElementById('quiz-difficulty-tag');
  const quizTypeTag = document.getElementById('quiz-type-tag');
  const quizScoreBadge = document.getElementById('quiz-score-badge');
  const quizQuestionText = document.getElementById('quiz-question-text');
  const quizStarBtn = document.getElementById('quiz-star-btn');
  const quizStarLabel = document.getElementById('quiz-star-label');
  const quizHintBox = document.getElementById('quiz-hint-box');
  const quizHintText = document.getElementById('quiz-hint-text');
  const quizImage = document.getElementById('quiz-image');
  const quizImageContainer = document.getElementById('quiz-image-container');
  const quizOptionsList = document.getElementById('quiz-options-list');
  const quizInputContainer = document.getElementById('quiz-input-container');
  const quizAnswerInput = document.getElementById('quiz-answer-input');
  const quizSubmitBtn = document.getElementById('quiz-submit-btn');
  const quizFeedbackBox = document.getElementById('quiz-feedback-box');

  currentSelectedOption = null;
  if (quizCategoryTag) quizCategoryTag.textContent = q.category || 'PLC/시퀀스';
  if (quizDifficultyTag) {
    const diffMap = { easy: '쉬움', medium: '보통', hard: '어려움' };
    quizDifficultyTag.textContent = diffMap[q.difficulty] || q.difficulty;
  }
  if (quizTypeTag) {
    const typeMap = { multiple_choice: '4지선다', short_answer: '단답형', ladder_input: '래더 명령어' };
    quizTypeTag.textContent = typeMap[q.question_type] || q.question_type;
  }
  if (quizScoreBadge) {
    const scoreMap = { easy: '+10점', medium: '+20점', hard: '+30점' };
    quizScoreBadge.textContent = scoreMap[q.difficulty] || '+20점';
  }
  if (quizQuestionText) quizQuestionText.textContent = q.question;

  if (quizStarBtn) quizStarBtn.classList.toggle('active', Boolean(q.is_starred));
  if (quizStarLabel) quizStarLabel.textContent = q.is_starred ? '보관됨' : '보관';

  if (quizHintBox) quizHintBox.classList.add('hidden');
  if (quizHintText) {
    quizHintText.textContent = q.hint || '이 문제에 등록된 힌트가 없습니다. 상세 해설을 참고해 보세요.';
  }

  if (q.image_filename) {
    if (quizImage) quizImage.src = `/api/quiz/images/${encodeURIComponent(q.image_filename)}`;
    quizImageContainer?.classList.remove('hidden');
  } else {
    quizImageContainer?.classList.add('hidden');
  }

  const isMultiple = q.question_type === 'multiple_choice' && Array.isArray(q.options) && q.options.length > 0;
  const isPracticeMode = currentQuizNav !== 'daily';

  if (isMultiple) {
    quizOptionsList?.classList.remove('hidden');
    quizInputContainer?.classList.add('hidden');
    renderMultipleChoiceOptions(q);
  } else {
    quizOptionsList?.classList.add('hidden');
    quizInputContainer?.classList.remove('hidden');
    if (quizAnswerInput) {
      quizAnswerInput.value = q.user_answer || '';
      quizAnswerInput.disabled = Boolean(q.is_solved && !isPracticeMode);
    }
    if (quizSubmitBtn) {
      quizSubmitBtn.disabled = false;
      quizSubmitBtn.textContent = (q.is_solved && isPracticeMode) ? '다시 풀기' : (q.is_solved ? '제출 완료' : '정답 제출');
    }
  }

  if (q.is_solved) {
    renderQuizFeedback(q);
  } else {
    quizFeedbackBox?.classList.add('hidden');
  }
}

export function renderMultipleChoiceOptions(q) {
  const quizOptionsList = document.getElementById('quiz-options-list');
  if (!quizOptionsList) return;
  quizOptionsList.replaceChildren();
  const circledNumbers = ['①', '②', '③', '④', '⑤', '⑥'];
  const isPracticeMode = currentQuizNav !== 'daily';

  q.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cbt-option-btn';

    const numSpan = document.createElement('span');
    numSpan.className = 'cbt-opt-num';
    numSpan.textContent = circledNumbers[idx] || `${idx + 1}.`;

    const textSpan = document.createElement('span');
    textSpan.className = 'cbt-opt-text';
    const cleanText = opt.replace(/^(\d+[\.\)]\s*|[①②③④⑤⑥]\s*)/, '');
    textSpan.textContent = cleanText || opt;

    btn.append(numSpan, textSpan);

    const isSelected = q.is_solved
      ? (q.user_answer === opt || q.user_answer === String(idx + 1) || q.user_answer === cleanText)
      : (currentSelectedOption === opt);

    if (isSelected) btn.classList.add('selected');

    if (q.is_solved && !isPracticeMode) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        currentSelectedOption = opt;
        renderMultipleChoiceOptions(q);
        submitQuiz(opt);
      });
    }
    quizOptionsList.appendChild(btn);
  });
}

export function renderQuizFeedback(q) {
  const quizFeedbackBox = document.getElementById('quiz-feedback-box');
  const quizResultBanner = document.getElementById('quiz-result-banner');
  const quizResultIcon = document.getElementById('quiz-result-icon');
  const quizResultTitle = document.getElementById('quiz-result-title');
  const quizResultAnswers = document.getElementById('quiz-result-answers');
  const quizExplanationText = document.getElementById('quiz-explanation-text');
  const quizSourceRef = document.getElementById('quiz-source-ref');

  if (!quizFeedbackBox) return;
  quizFeedbackBox.classList.remove('hidden');
  const isCorrect = Boolean(q.is_correct);
  if (quizResultBanner) {
    quizResultBanner.className = `cbt-result-banner ${isCorrect ? 'correct' : 'wrong'}`;
  }
  if (quizResultIcon) quizResultIcon.textContent = isCorrect ? '⭕' : '❌';
  if (quizResultTitle) {
    if (currentQuizNav === 'daily') {
      quizResultTitle.textContent = isCorrect ? `정답입니다! (+${q.score_earned || 20}점)` : '오답입니다!';
    } else {
      quizResultTitle.textContent = isCorrect ? '🎉 정답입니다!' : '❌ 아쉽게도 오답입니다.';
    }
  }
  if (quizResultAnswers) {
    if (isCorrect) {
      quizResultAnswers.textContent = `입력한 답: ${q.user_answer}`;
    } else {
      const correctText = Array.isArray(q.correct_answers) ? q.correct_answers.join(', ') : (q.correct_answers || '');
      quizResultAnswers.textContent = `내 답안: ${q.user_answer || '(미입력)'} | 올바른 정답: ${correctText}`;
    }
  }
  if (quizExplanationText) quizExplanationText.textContent = q.explanation || '해설이 없습니다.';
  if (quizSourceRef) quizSourceRef.textContent = q.source_ref ? `출처: ${q.source_ref}` : '';
}

export async function toggleStarCurrentQuiz() {
  const q = todayQuizzes[currentQuizIndex];
  if (!q) return;
  const quizStarBtn = document.getElementById('quiz-star-btn');
  const quizStarLabel = document.getElementById('quiz-star-label');
  try {
    const res = await fetch(`/api/quiz/bookmark/${q.id}`, { method: 'POST' });
    if (!res.ok) throw new Error('북마크 변경 실패');
    const data = await res.json();
    q.is_starred = data.is_starred;
    if (quizStarBtn) quizStarBtn.classList.toggle('active', Boolean(q.is_starred));
    if (quizStarLabel) quizStarLabel.textContent = q.is_starred ? '보관됨' : '보관';
    showToast(q.is_starred ? '⭐ 보관함에 문제를 저장했습니다.' : '보관을 해제했습니다.', 'info');
    refreshQuizSidebarCounts();
  } catch (err) {
    showToast(err.message || '북마크 처리에 실패했습니다.', 'error');
  }
}

export async function submitQuiz(answerVal = null) {
  const q = todayQuizzes[currentQuizIndex];
  if (!q) return;
  const isPracticeMode = currentQuizNav !== 'daily' || Boolean(q.is_solved);
  const endpoint = isPracticeMode ? '/api/quiz/retry' : '/api/quiz/submit';

  const quizAnswerInput = document.getElementById('quiz-answer-input');
  const quizSubmitBtn = document.getElementById('quiz-submit-btn');

  const answer = answerVal || (quizAnswerInput ? quizAnswerInput.value.trim() : '');
  if (!answer) {
    showToast('답안을 입력하거나 선택해 주세요.', 'warning');
    return;
  }
  if (quizSubmitBtn) quizSubmitBtn.disabled = true;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiz_id: q.id, answer: answer }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '답안 제출에 실패했습니다.');

    q.is_solved = true;
    q.is_correct = data.is_correct;
    q.user_answer = answer;
    q.score_earned = data.score_earned;
    q.correct_answers = data.correct_answers;
    q.explanation = data.explanation;
    q.source_ref = data.source_ref;

    if (data.user_stats) {
      userQuizStats = data.user_stats;
      renderQuizStats();
    }
    renderQuizPillNav();
    renderActiveQuiz();
    refreshQuizSidebarCounts();

    if (data.is_correct) {
      showToast(isPracticeMode ? '🎉 정답입니다! 멋지게 문제를 해결했습니다.' : `🎉 정답입니다! +${data.score_earned}점을 획득했습니다.`, 'success');
    } else {
      showToast('아쉽게도 오답입니다. 해설을 확인해 보세요.', 'info');
    }
  } catch (err) {
    showToast(err.message || '답안 제출 중 오류가 발생했습니다.', 'error');
  } finally {
    if (quizSubmitBtn) quizSubmitBtn.disabled = false;
  }
}

export async function fetchLeaderboard(period = 'weekly') {
  const leaderboardTbody = document.getElementById('leaderboard-tbody');
  const lbPeriodButtons = document.querySelectorAll('.lb-period-btn');
  if (!leaderboardTbody) return;
  lbPeriodButtons.forEach(b => b.classList.toggle('active', b.dataset.period === period));
  try {
    const res = await fetch(`/api/quiz/leaderboard?period=${period}`);
    if (!res.ok) throw new Error('리더보드를 불러오지 못했습니다.');
    const data = await res.json();
    renderLeaderboard(data.leaderboard || []);
  } catch (err) {
    showToast(err.message || '리더보드 조회 실패', 'error');
  }
}

export function renderLeaderboard(list) {
  const leaderboardPodium = document.getElementById('leaderboard-podium');
  const leaderboardTbody = document.getElementById('leaderboard-tbody');
  if (!leaderboardPodium || !leaderboardTbody) return;
  leaderboardPodium.replaceChildren();
  leaderboardTbody.replaceChildren();

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
    const score = document.createElement('span');
    score.className = 'podium-score';
    score.textContent = `${item.score || 0}점`;
    const streak = document.createElement('small');
    streak.className = 'field-hint';
    streak.textContent = item.current_streak ? `🔥 ${item.current_streak}일 연속` : '';
    card.append(icon, name, score, streak);
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

    const tdScore = document.createElement('td');
    tdScore.innerHTML = `<strong style="color: #60a5fa;">${item.score || 0}점</strong>`;

    const tdCorrect = document.createElement('td');
    tdCorrect.textContent = `${item.correct_count || 0}문제`;

    const tdStreak = document.createElement('td');
    tdStreak.textContent = item.current_streak ? `🔥 ${item.current_streak}일` : '-';

    tr.append(tdRank, tdUser, tdScore, tdCorrect, tdStreak);
    leaderboardTbody.appendChild(tr);
  });
}

export async function fetchAdminQuizzes() {
  const adminQuizList = document.getElementById('admin-quiz-list');
  const adminQuizTotalCount = document.getElementById('admin-quiz-total-count');
  if (!adminQuizList || state.currentUser?.role !== 'admin') return;
  try {
    const res = await fetch('/api/admin/quiz/list');
    if (!res.ok) return;
    const data = await res.json();
    const quizzes = data.quizzes || [];
    if (adminQuizTotalCount) adminQuizTotalCount.textContent = String(quizzes.length);
    adminQuizList.replaceChildren();

    if (quizzes.length === 0) {
      adminQuizList.innerHTML = '<div class="field-hint" style="padding: 10px;">등록된 퀴즈가 없습니다. 위 AI 생성이나 JSON 등록을 이용해 추가하세요.</div>';
      return;
    }

    quizzes.forEach(q => {
      const item = document.createElement('div');
      item.className = 'admin-quiz-item';

      const title = document.createElement('span');
      title.className = 'admin-quiz-item-title';
      title.textContent = `[${q.category}] ${q.question}`;
      title.title = q.question;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger-btn';
      delBtn.style.padding = '4px 10px';
      delBtn.style.fontSize = '0.76rem';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', async () => {
        if (!confirm('이 퀴즈를 삭제하시겠습니까?')) return;
        try {
          const dRes = await fetch(`/api/admin/quiz/${q.id}`, { method: 'DELETE' });
          if (!dRes.ok) throw new Error('삭제 실패');
          showToast('퀴즈가 삭제되었습니다.', 'info');
          fetchAdminQuizzes();
          fetchCategoriesSummary();
        } catch (err) {
          showToast(err.message || '삭제 실패', 'error');
        }
      });

      item.append(title, delBtn);
      adminQuizList.appendChild(item);
    });
  } catch { /* admin fetch error */ }
}

export function initQuizListeners() {
  const quizBtn = document.getElementById('quiz-btn');
  const quizModalClose = document.getElementById('quiz-modal-close');
  const quizModal = document.getElementById('quiz-modal');
  const quizNavDailyBtn = document.getElementById('quiz-nav-daily-btn');
  const quizNavRandomBtn = document.getElementById('quiz-nav-random-btn');
  const quizNavWrongBtn = document.getElementById('quiz-nav-wrong-btn');
  const quizNavStarredBtn = document.getElementById('quiz-nav-starred-btn');
  const quizNavHistoryBtn = document.getElementById('quiz-nav-history-btn');
  const quizNavLeaderboardBtn = document.getElementById('quiz-nav-leaderboard-btn');
  const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
  const quizStarBtn = document.getElementById('quiz-star-btn');
  const quizHintBtn = document.getElementById('quiz-hint-btn');
  const quizHintBox = document.getElementById('quiz-hint-box');
  const quizPrevBtn = document.getElementById('quiz-prev-btn');
  const quizNextBtn = document.getElementById('quiz-next-btn');
  const quizSubmitBtn = document.getElementById('quiz-submit-btn');
  const quizAnswerInput = document.getElementById('quiz-answer-input');
  const lbPeriodButtons = document.querySelectorAll('.lb-period-btn');
  const cbtHistFilterButtons = document.querySelectorAll('.cbt-hist-filter-btn');
  const quizAiGenForm = document.getElementById('quiz-ai-gen-form');
  const quizJsonImportForm = document.getElementById('quiz-json-import-form');

  if (quizBtn) quizBtn.addEventListener('click', () => openQuizModal('daily'));
  if (quizModalClose) quizModalClose.addEventListener('click', closeQuizModal);
  if (quizModal) {
    quizModal.addEventListener('click', (e) => {
      if (e.target === quizModal) closeQuizModal();
    });
  }

  if (quizNavDailyBtn) quizNavDailyBtn.addEventListener('click', () => switchQuizNav('daily'));
  if (quizNavRandomBtn) quizNavRandomBtn.addEventListener('click', () => switchQuizNav('random'));
  if (quizNavWrongBtn) quizNavWrongBtn.addEventListener('click', () => switchQuizNav('wrong'));
  if (quizNavStarredBtn) quizNavStarredBtn.addEventListener('click', () => switchQuizNav('starred'));
  if (quizNavHistoryBtn) quizNavHistoryBtn.addEventListener('click', () => switchQuizNav('history'));
  if (quizNavLeaderboardBtn) quizNavLeaderboardBtn.addEventListener('click', () => switchQuizNav('leaderboard'));
  if (quizNavAdminBtn) quizNavAdminBtn.addEventListener('click', () => switchQuizNav('admin'));

  if (quizStarBtn) quizStarBtn.addEventListener('click', toggleStarCurrentQuiz);
  if (quizHintBtn) quizHintBtn.addEventListener('click', () => quizHintBox?.classList.toggle('hidden'));

  if (quizPrevBtn) {
    quizPrevBtn.addEventListener('click', () => {
      if (currentQuizIndex > 0) {
        currentQuizIndex--;
        renderQuizPillNav();
        renderActiveQuiz();
      }
    });
  }

  if (quizNextBtn) {
    quizNextBtn.addEventListener('click', () => {
      if (currentQuizIndex < todayQuizzes.length - 1) {
        currentQuizIndex++;
        renderQuizPillNav();
        renderActiveQuiz();
      }
    });
  }

  if (quizSubmitBtn) {
    quizSubmitBtn.addEventListener('click', () => submitQuiz());
  }

  if (quizAnswerInput) {
    quizAnswerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuiz();
      }
    });
  }

  document.querySelectorAll('.cbt-chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!quizAnswerInput || quizAnswerInput.disabled) return;
      const sym = btn.dataset.sym || btn.textContent;
      quizAnswerInput.value += (quizAnswerInput.value ? ' ' : '') + sym;
      quizAnswerInput.focus();
    });
  });

  lbPeriodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      fetchLeaderboard(btn.dataset.period);
    });
  });

  cbtHistFilterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      cbtHistFilterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentHistoryFilter = btn.dataset.filter || 'all';
      renderSolvedHistoryAccordion();
    });
  });

  if (quizAiGenForm) {
    quizAiGenForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const quizGenStatus = document.getElementById('quiz-gen-status');
      const quizGenSubmit = document.getElementById('quiz-gen-submit');
      const quizGenCategory = document.getElementById('quiz-gen-category');
      const quizGenCount = document.getElementById('quiz-gen-count');
      const quizGenFile = document.getElementById('quiz-gen-file');
      const quizGenText = document.getElementById('quiz-gen-text');

      if (quizGenStatus) {
        quizGenStatus.textContent = '⏳ AI가 교재를 분석하여 퀴즈를 생성하고 있습니다... (약 5~15초 소요)';
        quizGenStatus.className = 'admin-status-msg loading';
      }
      if (quizGenSubmit) quizGenSubmit.disabled = true;

      const formData = new FormData();
      formData.append('category', quizGenCategory ? quizGenCategory.value : 'PLC/시퀀스');
      formData.append('count', quizGenCount ? quizGenCount.value : '5');
      if (quizGenFile && quizGenFile.files[0]) {
        formData.append('file', quizGenFile.files[0]);
      }
      if (quizGenText && quizGenText.value.trim()) {
        formData.append('text_content', quizGenText.value.trim());
      }

      try {
        const res = await fetch('/api/admin/quiz/ai-generate', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'AI 퀴즈 생성에 실패했습니다.');
        if (quizGenStatus) {
          quizGenStatus.textContent = `✅ ${data.created_count}개의 퀴즈가 성공적으로 생성 및 등록되었습니다!`;
          quizGenStatus.className = 'admin-status-msg success';
        }
        quizAiGenForm.reset();
        fetchAdminQuizzes();
        fetchCategoriesSummary();
        showToast(`${data.created_count}개 AI 퀴즈가 자동 등록되었습니다!`, 'success');
      } catch (err) {
        if (quizGenStatus) {
          quizGenStatus.textContent = `❌ ${err.message || '생성 실패'}`;
          quizGenStatus.className = 'admin-status-msg error';
        }
      } finally {
        if (quizGenSubmit) quizGenSubmit.disabled = false;
      }
    });
  }

  if (quizJsonImportForm) {
    quizJsonImportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const quizJsonStatus = document.getElementById('quiz-json-status');
      const quizJsonSubmit = document.getElementById('quiz-json-submit');
      const quizJsonInput = document.getElementById('quiz-json-input');

      if (quizJsonStatus) {
        quizJsonStatus.textContent = '⏳ JSON 데이터를 등록하는 중...';
        quizJsonStatus.className = 'admin-status-msg loading';
      }
      if (quizJsonSubmit) quizJsonSubmit.disabled = true;

      try {
        const parsed = JSON.parse(quizJsonInput.value.trim());
        const res = await fetch('/api/admin/quiz/import-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quizzes: parsed }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'JSON 등록 실패');
        if (quizJsonStatus) {
          quizJsonStatus.textContent = `✅ ${data.created_count}개 문제가 등록되었습니다.`;
          quizJsonStatus.className = 'admin-status-msg success';
        }
        quizJsonImportForm.reset();
        fetchAdminQuizzes();
        fetchCategoriesSummary();
        showToast(`${data.created_count}개 퀴즈가 등록되었습니다.`, 'success');
      } catch (err) {
        if (quizJsonStatus) {
          quizJsonStatus.textContent = `❌ ${err.message || 'JSON 파싱 또는 등록 실패'}`;
          quizJsonStatus.className = 'admin-status-msg error';
        }
      } finally {
        if (quizJsonSubmit) quizJsonSubmit.disabled = false;
      }
    });
  }
}
