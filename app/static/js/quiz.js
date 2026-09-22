// ============================================================
// Quiz Module: CBT Portal, Quiz Runner, History Accordion & Leaderboard
// ============================================================

import { state } from './state.js';
import { copyText, renderMarkdown, showToast } from './utils.js';
import {
  fetchLeaderboard,
  handleLeaderboardInvalidated,
  renderLeaderboard,
  currentLeaderboardPeriod,
  currentLeaderboardCategory,
} from './quiz_leaderboard.js';
import {
  loadMyQuizSets,
  fetchAdminQuizSubmissions,
  openAdminQuizEditor,
  fetchAdminQuizzes,
  openQuizFlagModal,
  closeQuizFlagModal,
  submitQuizFlag,
  syncExpertiseChoice,
  updateExpertiseEmoji,
  validateQuizDraft,
  notebookPromptV2,
  notebookPromptLegacy,
  setStatusLabel,
  getEditingMySetId,
  setEditingMySetId,
} from './quiz_admin.js';


let todayQuizzes = [];
let currentQuizIndex = 0;
let userQuizStats = null;
let currentSelectedOption = null;
let currentQuizNav = 'daily';
let solvedHistoryQuizzes = [];
let currentHistoryFilter = 'all';
let quizPageOffset = 0;
let quizPageLoading = false;
let quizHasMore = true;
let sidebarCategoryQuizzes = null;
let sidebarCategoryName = '';
let sidebarCategoryOffset = 0;
let sidebarCategoryHasMore = false;

let categoryTitlesMap = {};

export async function fetchSubjectTitlesMap() {
  try {
    const res = await fetch('/api/quiz/subject-titles');
    if (!res.ok) return;
    const data = await res.json();
    categoryTitlesMap = data.titles || {};
  } catch { /* ignore */ }
}

export function applyTitlesToInputs(category, rank1Id, rank2Id, rank3Id, iconId) {
  if (!category) return;
  const info = categoryTitlesMap[category];
  const r1 = document.getElementById(rank1Id);
  const r2 = document.getElementById(rank2Id);
  const r3 = document.getElementById(rank3Id);
  const ic = document.getElementById(iconId);
  if (info) {
    if (r1) r1.value = info.rank1_title || '';
    if (r2) r2.value = info.rank2_title || '';
    if (r3) r3.value = info.rank3_title || '';
    if (ic) ic.value = info.icon || '';
  }
}

export function getCategoryIcon(catName = '') {
  if (catName && categoryTitlesMap[catName]?.icon) return categoryTitlesMap[catName].icon;
  const lower = catName.toLowerCase();
  if (lower.includes('로봇') || lower.includes('robot')) return '🤖';
  if (lower.includes('plc') || lower.includes('시퀀스')) return '⚡';
  if (lower.includes('전기')) return '🔌';
  if (lower.includes('전자')) return '🔋';
  if (lower.includes('안전')) return '⛑️';
  if (lower.includes('기사')) return '📐';
  if (lower.includes('기능사')) return '🧰';
  if (lower.includes('넌센스')) return '💡';
  if (lower.includes('상식')) return '🌏';
  if (lower.includes('cbt') || lower.includes('기출')) return '📜';
  return '📖';
}

export async function refreshQuizHeaderStreak() {
  if (!state.currentUser) return;
  const headerQuizStreak = document.getElementById('header-quiz-streak');
  const headerStreakCount = document.getElementById('header-streak-count');
  const quizStreakPill = document.getElementById('quiz-streak-pill');
  try {
    const res = await fetch('/api/quiz/stats');
    if (!res.ok) return;
    const data = await res.json();
    userQuizStats = data;
    if (headerQuizStreak && headerStreakCount) {
      const streak = data.current_streak || 0;
      quizStreakPill?.classList.toggle('has-streak', streak > 0);
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

    categories.forEach(cat => {
      if (!categoryTitlesMap[cat.category]) {
        categoryTitlesMap[cat.category] = {
          icon: cat.icon || '',
          rank1_title: cat.rank1_title || '',
          rank2_title: cat.rank2_title || '',
          rank3_title: cat.rank3_title || '',
        };
      }
    });

    const subjectSelect = document.getElementById('cbt-subject-lb-select');
    if (subjectSelect) {
      const currentVal = subjectSelect.value;
      subjectSelect.innerHTML = '<option value="">전체 종합 순위</option>';
      categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.category;
        const icon = cat.icon || getCategoryIcon(cat.category);
        opt.textContent = `${icon} ${cat.category}`;
        subjectSelect.appendChild(opt);
      });
      if (currentVal) subjectSelect.value = currentVal;
    }

    const allCatNames = data.all_categories || categories.map(c => c.category);
    const datalist = document.getElementById('quiz-categories-datalist');
    if (datalist && allCatNames.length) {
      datalist.replaceChildren();
      allCatNames.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        datalist.appendChild(opt);
      });
    }

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
      icon.textContent = cat.icon || getCategoryIcon(cat.category);

      const text = document.createElement('span');
      text.className = 'cbt-nav-text';
      text.textContent = cat.category;

      const count = document.createElement('span');
      count.className = 'cbt-sidebar-count-badge';
      count.textContent = String(cat.count || 0);

      btn.append(icon, text, count);
      btn.addEventListener('click', () => {
        openSidebarCategoryPage(cat.category);
        switchQuizNav(`category:${cat.category}`, {
          title: `📚 ${cat.category}`,
          desc: `${cat.category} 분야의 핵심 퀴즈 문제입니다.`,
        });
      });
      quizSidebarCategoriesList.appendChild(btn);
    });
  } catch { /* ignore */ }
}

export async function openQuizModal(nav = 'daily') {
  const quizModal = document.getElementById('quiz-modal');
  const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
  if (!quizModal || !state.currentUser) return;
  quizModal.classList.remove('hidden');
  if (quizNavAdminBtn) {
    quizNavAdminBtn.classList.toggle('hidden', state.currentUser?.role !== 'admin');
  }
  await fetchSubjectTitlesMap();
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
  updateDailyCompletionCover();
  if (!navKey.startsWith('category:') && sidebarCategoryQuizzes) restoreSidebarTopics();
  const isHistory = navKey === 'history';
  const isQuizRunner = navKey === 'daily' || navKey === 'random' || navKey.startsWith('category:') || navKey === 'wrong' || navKey === 'starred';
  const isLb = navKey === 'leaderboard';
  const isAdmin = navKey === 'admin';
  const isMySets = navKey === 'mysets';

  const quizTabDailyContent = document.getElementById('quiz-tab-daily-content');
  const quizTabHistoryContent = document.getElementById('quiz-tab-history-content');
  const quizTabLeaderboardContent = document.getElementById('quiz-tab-leaderboard-content');
  const quizTabAdminContent = document.getElementById('quiz-tab-admin-content');
  const quizTabMySetsContent = document.getElementById('quiz-tab-mysets-content');
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
  quizTabMySetsContent?.classList.toggle('hidden', !isMySets);

  if (cbtMainHeader) cbtMainHeader.classList.toggle('hidden', isAdmin);
  if (cbtProgressRow) cbtProgressRow.classList.toggle('hidden', !isQuizRunner);

  const topicConfig = {
    daily: { title: '⚡ 오늘의 퀴즈', desc: '오늘의 퀴즈를 풀어 STREAK을 이어가세요. 점수는 모든 공용 퀴즈에서 획득할 수 있습니다.' },
    random: { title: '🔀 전체 랜덤 퀴즈', desc: '전체 등록된 퀴즈에서 무작위로 추출된 5개 문제를 풉니다.' },
    wrong: { title: '❌ 오답 복습', desc: '이전에 틀렸던 문제를 다시 풀고 완전히 마스터해 보세요.' },
    starred: { title: '⭐ 중요 문제 보관함', desc: '풀이 중 별표(북마크)로 저장해 둔 핵심 문제들을 복습합니다.' },
    history: { title: '📜 내가 푼 문제', desc: '과목별로 풀이한 퀴즈 목록과 상세 해설을 확인하세요.' },
    mysets: { title: '🧩 내 문제집 만들기', desc: 'NotebookLM JSON을 검증해 초안으로 저장하고 관리자 검토를 요청하세요.' },
    leaderboard: { title: '🏆 학습 랭킹 순위표', desc: '모든 공용 퀴즈에서 획득한 일일/주간/전체 점수 순위입니다.' },
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
    fetchAdminQuizSubmissions();
  } else if (isMySets) {
    loadMyQuizSets();
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
    historyTotalSummary.textContent = `총 ${totalSolved}문제 풀이 완료 (✅ ${correctCount}개 정답 / ❌ ${wrongCount}개 오답)`;
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
      p.textContent = `✅ ${groupCorrect}`;
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
      statusIcon.textContent = q.is_correct ? '✅' : '❌';

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

      const authorDiv = document.createElement('div');
      authorDiv.className = 'cbt-hist-author';
      authorDiv.textContent = `✍️ 출제: ${q.author_name || '대나무숲 공식'}`;
      detail.appendChild(authorDiv);

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

export async function fetchTodayQuizzes(category = null, append = false) {
  if (!state.currentUser) return;
  const quizLoadingText = document.getElementById('quiz-loading-text');
  const quizLoadingState = document.getElementById('quiz-loading-state');
  const quizContainer = document.getElementById('quiz-container');

  if (quizPageLoading) return;
  quizPageLoading = true;
  if (!append) {
    quizPageOffset = 0;
    quizHasMore = true;
    if (quizLoadingText) quizLoadingText.textContent = '문제를 불러오는 중입니다...';
    quizLoadingState?.classList.remove('hidden');
    quizContainer?.classList.add('hidden');
  }
  try {
    const existingIds = todayQuizzes.map(item => item.id).filter(Boolean);
    const params = new URLSearchParams({ count: '5' });
    if (category) params.set('category', category);

    if (append && existingIds.length > 0) {
      params.set('exclude', existingIds.join(','));
      params.set('offset', '0');
    } else {
      params.set('offset', String(quizPageOffset));
    }

    const url = `/api/quiz/today?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('퀴즈 목록을 불러오지 못했습니다.');
    const data = await res.json();
    const page = data.quizzes || [];

    if (append) {
      const existingIdSet = new Set(todayQuizzes.map(item => item.id));
      const uniqueNew = page.filter(item => !existingIdSet.has(item.id));
      todayQuizzes = todayQuizzes.concat(uniqueNew);
      quizHasMore = page.length === 5 && uniqueNew.length > 0;
      if (sidebarCategoryQuizzes) {
        const sideIdSet = new Set(sidebarCategoryQuizzes.map(item => item.id));
        const newForSide = uniqueNew.filter(item => !sideIdSet.has(item.id));
        if (newForSide.length > 0) {
          sidebarCategoryQuizzes = sidebarCategoryQuizzes.concat(newForSide);
        }
      }
    } else {
      todayQuizzes = page;
      quizHasMore = page.length === 5;
    }
    quizPageOffset = todayQuizzes.length;

    updateDailyCompletionCover();
    userQuizStats = data.stats || null;
    renderQuizStats();
    if (todayQuizzes.length > 0) {
      if (!append) {
        currentQuizIndex = 0;
        renderQuizPillNav();
        renderActiveQuiz();
      }
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
  } finally {
    quizPageLoading = false;
  }
}


function updateDailyCompletionCover() {
  const cover = document.getElementById('quiz-daily-complete-cover');
  if (!cover) return;
  const complete = currentQuizNav === 'daily' && todayQuizzes.length > 0 && todayQuizzes.every(item => item.is_solved);
  cover.classList.toggle('hidden', !complete);
}

async function openSidebarCategoryPage(category) {
  const section = document.querySelector('.quiz-question-sidebar-section');
  const back = document.getElementById('quiz-sidebar-back-btn');
  const title = document.getElementById('quiz-question-panel-title');
  document.querySelectorAll('.cbt-sidebar-section').forEach(item => item.classList.toggle('hidden', item !== section));
  back?.classList.remove('hidden');
  if (title) title.textContent = `📋 ${category} 문제 목록`;
  sidebarCategoryName = category;
  sidebarCategoryOffset = 0;
  sidebarCategoryHasMore = true;
  sidebarCategoryQuizzes = [];
  await loadSidebarCategoryPage(false);
}

async function loadSidebarCategoryPage(append = true) {
  const category = sidebarCategoryName;
  const more = document.getElementById('quiz-sidebar-more-btn');
  if (!category || (!sidebarCategoryHasMore && append)) return;
  try {
    const params = new URLSearchParams({ category, count: '50' });
    if (append && sidebarCategoryQuizzes && sidebarCategoryQuizzes.length > 0) {
      params.set('exclude', sidebarCategoryQuizzes.map(item => item.id).filter(Boolean).join(','));
      params.set('offset', '0');
    } else {
      params.set('offset', String(sidebarCategoryOffset));
    }
    const res = await fetch(`/api/quiz/today?${params}`);
    if (!res.ok) throw new Error('주제 문제 목록을 불러오지 못했습니다.');
    const page = (await res.json()).quizzes || [];
    if (append) {
      const existingIdSet = new Set(sidebarCategoryQuizzes.map(item => item.id));
      const uniqueNew = page.filter(item => !existingIdSet.has(item.id));
      sidebarCategoryQuizzes = sidebarCategoryQuizzes.concat(uniqueNew);
      sidebarCategoryHasMore = page.length === 50 && uniqueNew.length > 0;
    } else {
      sidebarCategoryQuizzes = page;
      sidebarCategoryHasMore = page.length === 50;
    }
    sidebarCategoryOffset = sidebarCategoryQuizzes.length;
    renderSidebarQuestionList(sidebarCategoryQuizzes);
    more?.classList.toggle('hidden', !sidebarCategoryHasMore);
  } catch (err) {
    const list = document.getElementById('quiz-sidebar-question-list');
    if (list) list.textContent = err.message;
  }
}

function restoreSidebarTopics() {
  sidebarCategoryQuizzes = null;
  sidebarCategoryName = '';
  sidebarCategoryOffset = 0;
  sidebarCategoryHasMore = false;
  document.querySelectorAll('.cbt-sidebar-section').forEach(item => item.classList.remove('hidden'));
  document.querySelector('.quiz-question-sidebar-section')?.classList.add('hidden');
  document.getElementById('quiz-sidebar-back-btn')?.classList.add('hidden');
  const title = document.getElementById('quiz-question-panel-title');
  if (title) title.textContent = '📋 문제 목록';
  renderSidebarQuestionList();
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
  if (quizStatStreak) quizStatStreak.textContent = `${userQuizStats.current_streak || 0}일 연속 🔥`;
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
  const solvedCount = todayQuizzes.filter(item => item.is_solved).length;
  const pct = Math.round((solvedCount / total) * 100);

  if (cbtProgressCount) cbtProgressCount.textContent = `${currentNum} / ${total}`;
  renderSidebarQuestionList();
  if (cbtProgressPercent) cbtProgressPercent.textContent = `${pct}% 풀이 완료`;
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
  const canLoadMore = currentQuizNav === 'random' || currentQuizNav.startsWith('category:');
  const atEnd = currentQuizIndex === todayQuizzes.length - 1;
  if (quizNextBtn) {
    quizNextBtn.disabled = atEnd && (!canLoadMore || !quizHasMore);
    if (atEnd && (!canLoadMore || !quizHasMore)) {
      quizNextBtn.textContent = '마지막 문제';
    } else {
      quizNextBtn.textContent = atEnd && canLoadMore && quizHasMore ? '5개 더' : '다음 문제 ▶';
    }
  }
}

function renderSidebarQuestionList(items = sidebarCategoryQuizzes || todayQuizzes) {
  const list = document.getElementById('quiz-sidebar-question-list');
  if (!list) return;
  list.replaceChildren();
  const currentQuiz = todayQuizzes[currentQuizIndex];
  const activeId = currentQuiz ? currentQuiz.id : null;
  items.forEach((q, idx) => {
    const button = document.createElement('button');
    button.type = 'button';
    const isActive = activeId !== null ? q.id === activeId : idx === currentQuizIndex;
    button.className = `quiz-sidebar-question${isActive ? ' active' : ''}`;
    if (q.is_solved) button.classList.add(q.is_correct ? 'solved-correct' : 'solved-wrong');
    const number = document.createElement('span'); number.className = 'quiz-sidebar-question-number'; number.textContent = String(idx + 1);
    const label = document.createElement('span'); label.className = 'quiz-sidebar-question-label'; label.textContent = q.question || '문제';
    button.append(number, label);
    button.addEventListener('click', () => {
      if (sidebarCategoryQuizzes) {
        todayQuizzes = sidebarCategoryQuizzes;
        quizHasMore = sidebarCategoryHasMore;
      }
      currentQuizIndex = idx;
      renderQuizPillNav();
      renderActiveQuiz();
    });
    list.appendChild(button);
  });
}

function getSuggestionChipsForQuiz(q) {
  if (!q) return [];
  const cat = (q.category || '').toLowerCase();
  const qText = (q.question || '').toLowerCase();
  const type = q.question_type || '';

  if (type === 'ladder_input' || cat.includes('plc') || cat.includes('시퀀스') || qText.includes('래더') || qText.includes('ladder')) {
    return ['X0', 'Y0', 'M0', 'T0', 'C0', 'AND', 'OR', 'OUT', 'LDI', 'SET', 'RST'];
  }
  if (cat.includes('전기') || cat.includes('회로') || qText.includes('저항') || qText.includes('전압') || qText.includes('전류')) {
    return ['V', 'A', 'Ω', 'W', 'Hz', 'F', 'H', 'kW', 'kΩ', 'μF'];
  }
  if (cat.includes('디지털') || cat.includes('논리') || cat.includes('전자') || qText.includes('게이트') || qText.includes('logic')) {
    return ['0', '1', 'AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR'];
  }
  if (cat.includes('로봇') || cat.includes('python') || cat.includes('파이썬') || qText.includes('def ') || qText.includes('import')) {
    return ['def', 'return', 'import', 'True', 'False', 'None', 'len', 'range'];
  }
  return [];
}

function renderSymbolChips(q, inputEl) {
  const chipsContainer = document.getElementById('quiz-symbol-chips');
  if (!chipsContainer || !inputEl) return;
  chipsContainer.replaceChildren();

  const symbols = getSuggestionChipsForQuiz(q);
  if (!symbols || symbols.length === 0) {
    chipsContainer.classList.add('hidden');
    return;
  }

  chipsContainer.classList.remove('hidden');
  const label = document.createElement('span');
  label.className = 'cbt-chip-label';
  label.textContent = '빠른 기호 입력:';
  chipsContainer.appendChild(label);

  symbols.forEach(sym => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cbt-chip-btn';
    btn.textContent = sym;
    btn.addEventListener('click', () => {
      const start = inputEl.selectionStart ?? inputEl.value.length;
      const end = inputEl.selectionEnd ?? inputEl.value.length;
      inputEl.setRangeText(sym, start, end, 'end');
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    chipsContainer.appendChild(btn);
  });
}

export function renderActiveQuiz() {
  const q = todayQuizzes[currentQuizIndex];
  if (!q) return;

  const quizCategoryTag = document.getElementById('quiz-category-tag');
  const quizAuthorTag = document.getElementById('quiz-author-tag');
  const quizAuthorRef = document.getElementById('quiz-author-ref');
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
  if (quizCategoryTag) quizCategoryTag.textContent = q.category || 'PLC';
  const authorDisplay = q.author_name ? q.author_name : '대나무숲 공식';
  if (quizAuthorTag) {
    quizAuthorTag.textContent = `✍️ ${authorDisplay}`;
    quizAuthorTag.title = `출제자: ${authorDisplay}`;
  }
  if (quizAuthorRef) {
    quizAuthorRef.textContent = `출제: ${authorDisplay}`;
  }
  if (quizDifficultyTag) {
    const diffMap = { easy: '쉬움', medium: '보통', hard: '어려움' };
    quizDifficultyTag.textContent = diffMap[q.difficulty] || q.difficulty;
  }
  if (quizTypeTag) {
    const typeMap = { multiple_choice: '4지선다', short_answer: '단답형', ladder_input: '래더 명령어' };
    quizTypeTag.textContent = typeMap[q.question_type] || q.question_type;
  }
  if (quizScoreBadge) {
    if (q.is_solved) {
      quizScoreBadge.textContent = q.score_earned > 0 ? `+${q.score_earned}점` : '재풀이 · 0점';
    } else {
      const scoreMap = { easy: '+10점', medium: '+20점', hard: '+30점' };
      quizScoreBadge.textContent = scoreMap[q.difficulty] || '+20점';
    }
  }
  if (quizQuestionText) renderMarkdown(quizQuestionText, q.question);

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
    document.getElementById('quiz-symbol-chips')?.classList.add('hidden');
    renderMultipleChoiceOptions(q);
  } else {
    quizOptionsList?.classList.add('hidden');
    quizInputContainer?.classList.remove('hidden');
    if (quizAnswerInput) {
      quizAnswerInput.value = q.user_answer || '';
      quizAnswerInput.disabled = Boolean(q.is_solved && !isPracticeMode);
      renderSymbolChips(q, quizAnswerInput);
    }
    if (quizSubmitBtn) {
      quizSubmitBtn.disabled = Boolean(q.is_solved && !isPracticeMode);
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
  if (quizResultIcon) quizResultIcon.textContent = isCorrect ? '✅' : '❌';
  if (quizResultTitle) {
    if (isCorrect) {
      if (q.score_earned > 0) {
        quizResultTitle.textContent = `정답입니다! (+${q.score_earned}점)`;
      } else {
        quizResultTitle.textContent = '🎉 숙달했습니다! (연습 · 0점)';
      }
    } else {
      quizResultTitle.textContent = currentQuizNav === 'daily' ? '오답입니다!' : '❌ 아쉽게도 오답입니다.';
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
    if (sidebarCategoryQuizzes) {
      const match = sidebarCategoryQuizzes.find(item => item.id === q.id);
      if (match) match.is_starred = data.is_starred;
    }
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
  if (currentQuizNav === 'daily' && q.is_solved) {
    showToast('오늘의 퀴즈는 한 번만 제출할 수 있습니다. 다시 풀기는 복습 탭을 이용해 주세요.', 'info');
    return;
  }
  const endpoint = q.is_solved ? '/api/quiz/retry' : '/api/quiz/submit';

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

    if (sidebarCategoryQuizzes) {
      const match = sidebarCategoryQuizzes.find(item => item.id === q.id);
      if (match) {
        match.is_solved = true;
        match.is_correct = data.is_correct;
        match.user_answer = answer;
        match.score_earned = data.score_earned;
        match.correct_answers = data.correct_answers;
        match.explanation = data.explanation;
        match.source_ref = data.source_ref;
      }
    }

    if (data.user_stats) {
      userQuizStats = data.user_stats;
      renderQuizStats();
    }
    renderQuizPillNav();
    renderActiveQuiz();
    updateDailyCompletionCover();
    refreshQuizSidebarCounts();

    if (data.is_correct) {
      showToast(data.score_earned > 0 ? `🎉 정답입니다! +${data.score_earned}점을 획득했습니다.` : '🎉 재풀이 정답입니다!', 'success');
    } else {
      showToast('아쉽게도 오답입니다. 해설을 확인해 보세요.', 'info');
    }
  } catch (err) {
    showToast(err.message || '답안 제출 중 오류가 발생했습니다.', 'error');
  } finally {
    if (quizSubmitBtn) quizSubmitBtn.disabled = false;
  }
}


// Re-export modularized Leaderboard and Admin components for full backward compatibility
export {
  fetchLeaderboard,
  handleLeaderboardInvalidated,
  renderLeaderboard,
  currentLeaderboardPeriod,
  currentLeaderboardCategory,
} from './quiz_leaderboard.js';

export {
  loadMyQuizSets,
  fetchAdminQuizSubmissions,
  openAdminQuizEditor,
  fetchAdminQuizzes,
  openQuizFlagModal,
  closeQuizFlagModal,
  submitQuizFlag,
  syncExpertiseChoice,
  updateExpertiseEmoji,
  validateQuizDraft,
  notebookPromptV2,
  notebookPromptLegacy,
  setStatusLabel,
} from './quiz_admin.js';

export function initQuizListeners() {
  const quizBtn = document.getElementById('quiz-btn');
  const quizModalClose = document.getElementById('quiz-modal-close');
  const quizModal = document.getElementById('quiz-modal');
  const quizNavDailyBtn = document.getElementById('quiz-nav-daily-btn');
  const quizNavRandomBtn = document.getElementById('quiz-nav-random-btn');
  const quizNavWrongBtn = document.getElementById('quiz-nav-wrong-btn');
  const quizNavStarredBtn = document.getElementById('quiz-nav-starred-btn');
  const quizNavHistoryBtn = document.getElementById('quiz-nav-history-btn');
  const quizNavMySetsBtn = document.getElementById('quiz-nav-mysets-btn');
  const quizNavLeaderboardBtn = document.getElementById('quiz-nav-leaderboard-btn');
  const quizNavAdminBtn = document.getElementById('quiz-nav-admin-btn');
  const quizSidebarMoreBtn = document.getElementById('quiz-sidebar-more-btn');
  const quizSidebarBackBtn = document.getElementById('quiz-sidebar-back-btn');
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
  const quizSetSaveBtn = document.getElementById('quiz-set-save-btn');
  const quizSetValidateBtn = document.getElementById('quiz-set-validate-btn');
  const quizCopyPromptBtn = document.getElementById('quiz-copy-prompt-btn');
  const quizDailyPublishBtn = document.getElementById('quiz-daily-publish-btn');
  const quizFarmPointsBtn = document.getElementById('quiz-farm-points-btn');
  const adminQuizNewBtn = document.getElementById('admin-quiz-new-btn');
  const adminQuizEditor = document.getElementById('admin-quiz-editor');
  const adminQuizEditorCancel = document.getElementById('admin-quiz-editor-cancel');

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
  if (quizNavMySetsBtn) quizNavMySetsBtn.addEventListener('click', () => switchQuizNav('mysets'));
  if (quizNavLeaderboardBtn) quizNavLeaderboardBtn.addEventListener('click', () => switchQuizNav('leaderboard'));
  if (quizNavAdminBtn) quizNavAdminBtn.addEventListener('click', () => switchQuizNav('admin'));
  quizSidebarBackBtn?.addEventListener('click', () => restoreSidebarTopics());
  quizSidebarMoreBtn?.addEventListener('click', () => loadSidebarCategoryPage(true));
  quizFarmPointsBtn?.addEventListener('click', () => switchQuizNav('random'));
  adminQuizNewBtn?.addEventListener('click', () => openAdminQuizEditor());
  adminQuizEditorCancel?.addEventListener('click', () => adminQuizEditor?.classList.add('hidden'));

  const adminQuizCat = document.getElementById('admin-quiz-category');
  if (adminQuizCat && !adminQuizCat.dataset.boundTitle) {
    adminQuizCat.dataset.boundTitle = 'true';
    adminQuizCat.addEventListener('input', (e) => {
      applyTitlesToInputs(e.target.value.trim(), 'admin-quiz-rank1', 'admin-quiz-rank2', 'admin-quiz-rank3', 'admin-quiz-icon');
    });
  }
  adminQuizEditor?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('admin-quiz-editor-status');
    try {
      const type = document.getElementById('admin-quiz-type').value;
      const lines = id => document.getElementById(id).value.split('\n').map(value => value.trim()).filter(Boolean);
      const authorVal = document.getElementById('admin-quiz-author')?.value.trim();
      const payload = {
        category: document.getElementById('admin-quiz-category').value.trim(),
        difficulty: document.getElementById('admin-quiz-difficulty').value,
        question_type: type,
        question: document.getElementById('admin-quiz-question').value.trim(),
        options: type === 'multiple_choice' ? lines('admin-quiz-options') : null,
        correct_answers: lines('admin-quiz-answers'),
        hint: document.getElementById('admin-quiz-hint').value.trim(),
        source_ref: document.getElementById('admin-quiz-source').value.trim(),
        explanation: document.getElementById('admin-quiz-explanation').value.trim(),
      };
      if (authorVal) payload.author_name = authorVal;
      const rank1 = document.getElementById('admin-quiz-rank1')?.value.trim();
      const rank2 = document.getElementById('admin-quiz-rank2')?.value.trim();
      const rank3 = document.getElementById('admin-quiz-rank3')?.value.trim();
      const icon = document.getElementById('admin-quiz-icon')?.value.trim();
      if (rank1) payload.rank1_title = rank1;
      if (rank2) payload.rank2_title = rank2;
      if (rank3) payload.rank3_title = rank3;
      if (icon) payload.icon = icon;
      const id = document.getElementById('admin-quiz-edit-id').value;
      const response = await fetch(id ? `/api/admin/quiz/${id}` : '/api/admin/quiz', {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await response.json(); if (!response.ok) throw new Error(data.detail || '저장 실패');
      status.className = 'admin-status-msg success'; status.textContent = id ? `#${id} 문항을 수정했습니다.` : `#${data.quiz_id} 문항을 생성했습니다.`;
      showToast(id ? '퀴즈를 수정했습니다.' : '새 퀴즈를 등록했습니다.', 'success');
      await fetchSubjectTitlesMap();
      await fetchAdminQuizzes(); fetchCategoriesSummary(); loadMyQuizSets();
      if (!id) adminQuizEditor.reset();
    } catch (err) { status.className = 'admin-status-msg error'; status.textContent = err.message; }
  });

  quizCopyPromptBtn?.addEventListener('click', async () => {
    await copyText(
      document.getElementById('quiz-notebook-prompt')?.value || '',
      'NotebookLM 프롬프트를 복사했습니다.',
    );
  });

  quizSetValidateBtn?.addEventListener('click', async () => {
    try {
      await validateQuizDraft();
    } catch (err) {
      const status = document.getElementById('quiz-set-status');
      if (status) {
        status.className = 'admin-status-msg error';
        status.textContent = err instanceof SyntaxError ? '유효한 JSON 배열인지 확인하세요.' : err.message;
      }
    }
  });

  quizSetSaveBtn?.addEventListener('click', async () => {
    const status = document.getElementById('quiz-set-status');
    try {
      const quizzes = JSON.parse(document.getElementById('quiz-set-json')?.value || '');
      const validation = await validateQuizDraft();
      const body = {
        title: document.getElementById('quiz-set-title')?.value || '',
        expertise: document.getElementById('quiz-set-expertise')?.value || '',
        rank1_title: document.getElementById('quiz-set-rank1')?.value?.trim() || '',
        rank2_title: document.getElementById('quiz-set-rank2')?.value?.trim() || '',
        rank3_title: document.getElementById('quiz-set-rank3')?.value?.trim() || '',
        icon: document.getElementById('quiz-set-icon')?.value?.trim() || '',
        quizzes,
      };
      const editId = getEditingMySetId();
      const editing = editId !== null;
      const res = await fetch(editing ? `/api/quiz/my-sets/${editId}` : '/api/quiz/my-sets', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || '저장 실패');
      if (status) {
        status.className = `admin-status-msg ${validation.warnings?.length ? 'warning' : 'success'}`;
        status.textContent = validation.warnings?.length
          ? `초안 저장 완료 · 검토 필요: ${validation.warnings.join(' ')}`
          : 'JSON·DB 유사도·정답 분포 검증을 통과해 초안으로 저장했습니다.';
      }
      document.getElementById('quiz-set-json').value = '';
      if (document.getElementById('quiz-set-rank1')) document.getElementById('quiz-set-rank1').value = '';
      if (document.getElementById('quiz-set-rank2')) document.getElementById('quiz-set-rank2').value = '';
      if (document.getElementById('quiz-set-rank3')) document.getElementById('quiz-set-rank3').value = '';
      if (document.getElementById('quiz-set-icon')) document.getElementById('quiz-set-icon').value = '';
      setEditingMySetId(null); quizSetSaveBtn.textContent = '초안 저장'; loadMyQuizSets(); fetchCategoriesSummary();
    } catch (err) {
      if (status) { status.className = 'admin-status-msg error'; status.textContent = err instanceof SyntaxError ? '유효한 JSON 배열인지 확인하세요.' : err.message; }
    }
  });

  quizDailyPublishBtn?.addEventListener('click', async () => {
    const status = document.getElementById('quiz-daily-status');
    try {
      const assigned_date = document.getElementById('quiz-daily-date')?.value || '';
      const quiz_ids = (document.getElementById('quiz-daily-ids')?.value || '').split(',').map(value => Number(value.trim())).filter(Number.isInteger);
      const res = await fetch('/api/admin/quiz/daily-sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_date, quiz_ids }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || '게시 실패');
      if (status) { status.className = 'admin-status-msg success'; status.textContent = `${assigned_date} 세트를 변경 불가 상태로 게시했습니다.`; }
    } catch (err) { if (status) { status.className = 'admin-status-msg error'; status.textContent = err.message; } }
  });

  if (quizStarBtn) quizStarBtn.addEventListener('click', toggleStarCurrentQuiz);
  if (quizHintBtn) quizHintBtn.addEventListener('click', () => quizHintBox?.classList.toggle('hidden'));

  const quizFlagBtn = document.getElementById('quiz-flag-btn');
  if (quizFlagBtn) {
    quizFlagBtn.addEventListener('click', () => {
      const q = todayQuizzes[currentQuizIndex];
      if (q) openQuizFlagModal(q);
    });
  }

  const quizFlagCloseBtn = document.getElementById('quiz-flag-close-btn');
  const quizFlagCancelBtn = document.getElementById('quiz-flag-cancel-btn');
  const quizFlagForm = document.getElementById('quiz-flag-form');
  const quizFlagModal = document.getElementById('quiz-flag-modal');
  quizFlagCloseBtn?.addEventListener('click', closeQuizFlagModal);
  quizFlagCancelBtn?.addEventListener('click', closeQuizFlagModal);
  quizFlagModal?.addEventListener('click', (e) => {
    if (e.target === quizFlagModal) closeQuizFlagModal();
  });
  quizFlagForm?.addEventListener('submit', submitQuizFlag);

  // Admin Search & Filter Toolbar
  const adminQuizSearchInput = document.getElementById('admin-quiz-search');
  const adminQuizSearchClear = document.getElementById('admin-quiz-search-clear');
  const adminQuizCatFilter = document.getElementById('admin-quiz-category-filter');
  const adminQuizFlaggedToggle = document.getElementById('admin-quiz-flagged-toggle');

  if (adminQuizSearchInput) {
    adminQuizSearchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (adminQuizSearchClear) adminQuizSearchClear.classList.toggle('hidden', !val);
      clearTimeout(adminQuizSearchTimer);
      adminQuizSearchTimer = setTimeout(() => {
        adminQuizSearch = val.trim();
        fetchAdminQuizzes();
      }, 250);
    });
  }

  if (adminQuizSearchClear) {
    adminQuizSearchClear.addEventListener('click', () => {
      if (adminQuizSearchInput) adminQuizSearchInput.value = '';
      adminQuizSearchClear.classList.add('hidden');
      adminQuizSearch = '';
      fetchAdminQuizzes();
    });
  }

  if (adminQuizCatFilter) {
    adminQuizCatFilter.addEventListener('change', (e) => {
      adminQuizCategory = e.target.value;
      fetchAdminQuizzes();
    });
  }

  if (adminQuizFlaggedToggle) {
    adminQuizFlaggedToggle.addEventListener('click', () => {
      adminQuizFlaggedOnly = !adminQuizFlaggedOnly;
      adminQuizFlaggedToggle.classList.toggle('active', adminQuizFlaggedOnly);
      fetchAdminQuizzes();
    });
  }

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
    quizNextBtn.addEventListener('click', async () => {
      if (currentQuizIndex < todayQuizzes.length - 1) {
        currentQuizIndex++;
        renderQuizPillNav();
        renderActiveQuiz();
      } else if (currentQuizNav === 'random' || currentQuizNav.startsWith('category:')) {
        const category = currentQuizNav === 'random' ? 'random' : currentQuizNav.replace('category:', '');
        const previousLength = todayQuizzes.length;
        quizNextBtn.disabled = true;
        quizNextBtn.textContent = '불러오는 중...';
        try {
          await fetchTodayQuizzes(category, true);
          if (todayQuizzes.length > previousLength) {
            currentQuizIndex = previousLength;
            renderQuizPillNav();
            renderActiveQuiz();
            showToast(`새로운 문제 ${todayQuizzes.length - previousLength}문항을 추가로 불러왔습니다. (${currentQuizIndex + 1}/${todayQuizzes.length})`, 'success');
          } else {
            showToast('해당 주제의 모든 문제를 확인했습니다!', 'info');
            quizHasMore = false;
            renderQuizPillNav();
          }
        } finally {
          renderQuizPillNav();
        }
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
      const subjectSelect = document.getElementById('cbt-subject-lb-select');
      if (subjectSelect) subjectSelect.value = '';
      fetchLeaderboard(btn.dataset.period);
    });
  });

  const subjectLbSelect = document.getElementById('cbt-subject-lb-select');
  if (subjectLbSelect) {
    subjectLbSelect.addEventListener('change', () => {
      const category = subjectLbSelect.value;
      if (category) {
        fetchLeaderboard('subject', category);
      } else {
        fetchLeaderboard('weekly');
      }
    });
  }

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
      formData.append('category', quizGenCategory ? quizGenCategory.value : 'PLC');
      formData.append('count', quizGenCount ? quizGenCount.value : '5');
      const aiRank1 = document.getElementById('quiz-ai-rank1')?.value.trim();
      const aiRank2 = document.getElementById('quiz-ai-rank2')?.value.trim();
      const aiRank3 = document.getElementById('quiz-ai-rank3')?.value.trim();
      const aiIcon = document.getElementById('quiz-ai-icon')?.value.trim();
      if (aiRank1) formData.append('rank1_title', aiRank1);
      if (aiRank2) formData.append('rank2_title', aiRank2);
      if (aiRank3) formData.append('rank3_title', aiRank3);
      if (aiIcon) formData.append('icon', aiIcon);
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
        await fetchSubjectTitlesMap();
        fetchAdminQuizzes();
        fetchCategoriesSummary();
        loadMyQuizSets();
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
        const jsonCat = document.getElementById('quiz-json-category')?.value.trim();
        const jsonRank1 = document.getElementById('quiz-json-rank1')?.value.trim();
        const jsonRank2 = document.getElementById('quiz-json-rank2')?.value.trim();
        const jsonRank3 = document.getElementById('quiz-json-rank3')?.value.trim();
        const jsonIcon = document.getElementById('quiz-json-icon')?.value.trim();
        const payload = { quizzes: parsed };
        if (jsonCat) payload.category = jsonCat;
        if (jsonRank1) payload.rank1_title = jsonRank1;
        if (jsonRank2) payload.rank2_title = jsonRank2;
        if (jsonRank3) payload.rank3_title = jsonRank3;
        if (jsonIcon) payload.icon = jsonIcon;
        const res = await fetch('/api/admin/quiz/import-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'JSON 등록 실패');
        if (quizJsonStatus) {
          quizJsonStatus.textContent = `✅ ${data.created_count}개 문제가 등록되었습니다.`;
          quizJsonStatus.className = 'admin-status-msg success';
        }
        quizJsonImportForm.reset();
        await fetchSubjectTitlesMap();
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
