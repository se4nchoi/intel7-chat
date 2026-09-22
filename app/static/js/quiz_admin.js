// ============================================================
// Quiz Admin Submodule: Sets, Submissions, Editor & Flags
// ============================================================

import { state } from './state.js';
import { showToast } from './utils.js';
import { applyTitlesToInputs, fetchCategoriesSummary, getCategoryIcon } from './quiz.js';

let editingMySetId = null;
let adminQuizSearch = '';
let adminQuizCategory = '';
let adminQuizFlaggedOnly = false;
let currentFlagTargetQuiz = null;

export function notebookPromptLegacy(expertise) {
  return `아래 자료만 근거로 ${expertise} 분야의 학습 퀴즈를 만들어 주세요. 결과는 설명이나 Markdown 울타리 없이 유효한 JSON 배열만 출력하세요. 각 객체는 difficulty(easy|medium|hard), question_type(multiple_choice|short_answer|ladder_input), question, options, correct_answers, hint, explanation, source_ref 필드만 가집니다. 객관식 options는 정확히 4개이며 정답 번호와 보기 본문을 correct_answers에 함께 넣으세요. 단답형/래더형 options는 null입니다. 외부 이미지·URL·HTML은 사용하지 마세요. 회로 또는 도면이 필요하면 question 문자열 안에 삼중 백틱으로 감싼 고정폭 ASCII 도면을 넣으세요. 자료에 없는 사실은 추측하지 말고, 문항마다 충분한 해설과 자료 위치를 넣으세요.`;
}

export function notebookPromptV2(expertise) {
  return `당신은 ${expertise} 분야의 자격시험 출제자입니다. 사용자가 제공한 자료에만 근거하여 초급~중급 학습 퀴즈를 10문항 만들어 주세요.\n\n출력 규칙(중요): 응답 전체는 설명·제목·Markdown fence 없이 JSON 배열 하나만 출력합니다. 첫 글자는 [, 마지막 글자는 ]이어야 합니다. JSON은 큰따옴표를 사용하고 trailing comma를 넣지 않습니다.\n각 객체는 difficulty, question_type, question, options, correct_answers, hint, explanation, source_ref 키만 사용합니다. category, id, image_filename, image_url 같은 추가 키는 금지합니다.\ndifficulty는 easy|medium|hard 중 하나, question_type은 multiple_choice|short_answer|ladder_input 중 하나입니다. 객관식 options는 정확히 4개이고 correct_answers에는 정답 번호(예: \"2\")와 정답 문구를 함께 넣습니다. 단답형/래더형 options는 null입니다.\n이미지·이미지 URL·HTML·외부 링크는 금지합니다. 도면이 필요하면 question 문자열 안에만 삼중 백틱 ASCII 코드 블록을 넣습니다(전체 JSON을 fence로 감싸면 안 됩니다). 자료에 없는 수치·규정·오류 코드·정답은 추측하지 말고 source_ref에 장·절·페이지를 적습니다.\n모든 문항은 ${expertise} 범위에만 해당해야 합니다. 위 규칙을 지켜 JSON 배열만 출력하세요.`;
}

export function setStatusLabel(status) {
  return ({ draft: '초안', pending_review: '검토 대기', approved: '승인됨', rejected: '반려됨' })[status] || status;
}

export function updateExpertiseEmoji(value) {
  const emoji = document.getElementById('quiz-set-emoji');
  if (emoji) emoji.textContent = getCategoryIcon(value);
}

export function syncExpertiseChoice(value, focusCustom = false) {
  const choice = document.getElementById('quiz-set-expertise-choice');
  const custom = document.getElementById('quiz-set-expertise');
  if (!choice || !custom) return;
  if (value && value !== '__custom__') {
    const exists = Array.from(choice.options).some(option => option.value === value);
    if (!exists) {
      choice.add(new Option(value, value));
    }
  }
  const predefined = Array.from(choice.options).some(option => option.value === value && value !== '__custom__');
  choice.value = predefined ? value : '__custom__';
  custom.classList.toggle('hidden', predefined);
  custom.value = predefined ? value : (value === '__custom__' ? '' : value);
  updateExpertiseEmoji(custom.value);
  applyTitlesToInputs(custom.value, 'quiz-set-rank1', 'quiz-set-rank2', 'quiz-set-rank3', 'quiz-set-icon');
  if (focusCustom && !predefined) setTimeout(() => custom.focus(), 0);
}

export async function validateQuizDraft() {
  const status = document.getElementById('quiz-set-status');
  const quizzes = JSON.parse(document.getElementById('quiz-set-json')?.value || '');
  const expertise = document.getElementById('quiz-set-expertise')?.value || '';
  const response = await fetch('/api/quiz/my-sets/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expertise, quizzes }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '문제집 검증에 실패했습니다.');
  const bias = data.answer_bias || {};
  const distribution = bias.multiple_choice_count
    ? `정답 분포 ①${bias.counts?.['1'] || 0} ②${bias.counts?.['2'] || 0} ③${bias.counts?.['3'] || 0} ④${bias.counts?.['4'] || 0}`
    : '객관식 문항 없음';
  const similar = (data.similarities || []).slice(0, 3)
    .map(item => `${item.candidate_index}번↔DB #${item.existing_quiz_id} ${item.similarity}%`)
    .join(' · ');
  const summary = data.warnings?.length
    ? `${data.warnings.join(' ')} ${distribution}${similar ? ` · ${similar}` : ''}`
    : `검증 완료: ${data.question_count}문항 · ${distribution} · 뚜렷한 중복 후보 없음`;
  if (status) {
    status.className = `admin-status-msg ${data.warnings?.length ? 'warning' : 'success'}`;
    status.textContent = summary;
  }
  return data;
}

export async function loadMyQuizSets() {
  const expertise = document.getElementById('quiz-set-expertise');
  const expertiseChoice = document.getElementById('quiz-set-expertise-choice');
  const prompt = document.getElementById('quiz-notebook-prompt');
  const list = document.getElementById('quiz-mysets-list');
  if (!list) return;
  try {
    const [expertiseRes, setsRes] = await Promise.all([fetch('/api/quiz/expertises'), fetch('/api/quiz/my-sets')]);
    if (!expertiseRes.ok || !setsRes.ok) throw new Error('문제집 정보를 불러오지 못했습니다.');
    const expertises = (await expertiseRes.json()).expertises || [];
    if (expertise && expertiseChoice) {
      const currentSelected = expertiseChoice.value;
      const existingValues = new Set(Array.from(expertiseChoice.options, option => option.value));
      expertises.forEach(value => {
        if (!existingValues.has(value)) expertiseChoice.add(new Option(value, value));
      });
      if (currentSelected && currentSelected !== '__custom__') {
        expertiseChoice.value = currentSelected;
      }
      if (!expertiseChoice.dataset.changeBound) {
        expertiseChoice.dataset.changeBound = 'true';
        expertiseChoice.addEventListener('change', () => {
          syncExpertiseChoice(expertiseChoice.value, true);
          if (prompt) prompt.value = notebookPromptV2(expertise.value || '새 주제');
        });
        expertise.addEventListener('input', () => {
          updateExpertiseEmoji(expertise.value);
          applyTitlesToInputs(expertise.value, 'quiz-set-rank1', 'quiz-set-rank2', 'quiz-set-rank3', 'quiz-set-icon');
          if (prompt) prompt.value = notebookPromptV2(expertise.value || '새 주제');
        });
      }
    }

    const datalist = document.getElementById('quiz-categories-datalist');
    if (datalist && expertises.length) {
      datalist.replaceChildren();
      expertises.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        datalist.appendChild(opt);
      });
    }

    if (expertise && !expertise.value && expertises.length) {
      syncExpertiseChoice(expertises[0]);
    } else if (expertise && expertise.value) {
      syncExpertiseChoice(expertise.value);
    }
    updateExpertiseEmoji(expertise?.value || expertises[0] || 'PLC');
    if (prompt) prompt.value = notebookPromptV2(expertise?.value || expertises[0] || 'PLC');
    renderMyQuizSets((await setsRes.json()).sets || []);
  } catch (err) {
    list.textContent = err.message;
  }
}

function renderMyQuizSets(sets) {
  const list = document.getElementById('quiz-mysets-list');
  if (!list) return;
  list.replaceChildren();
  if (!sets.length) { list.textContent = '저장한 문제집이 없습니다.'; return; }
  sets.forEach(set => {
    const card = document.createElement('article'); card.className = 'quiz-set-item';
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = set.title;
    const meta = document.createElement('span'); meta.textContent = `${set.expertise} · ${set.quizzes.length}문항 · ${setStatusLabel(set.status)}`;
    info.append(title, meta);
    if (set.review_note) { const note = document.createElement('small'); note.textContent = `검토 의견: ${set.review_note}`; info.append(note); }
    card.appendChild(info);
    if (set.status === 'draft' || set.status === 'rejected') {
      const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'secondary-btn'; editButton.textContent = '수정';
      editButton.addEventListener('click', () => {
        editingMySetId = set.id;
        const expertise = document.getElementById('quiz-set-expertise');
        const titleInput = document.getElementById('quiz-set-title');
        const jsonInput = document.getElementById('quiz-set-json');
        if (expertise) syncExpertiseChoice(set.expertise);
        if (titleInput) titleInput.value = set.title;
        if (jsonInput) jsonInput.value = JSON.stringify(set.quizzes, null, 2);
        const r1 = document.getElementById('quiz-set-rank1');
        const r2 = document.getElementById('quiz-set-rank2');
        const r3 = document.getElementById('quiz-set-rank3');
        const ic = document.getElementById('quiz-set-icon');
        if (r1) r1.value = set.rank1_title || '';
        if (r2) r2.value = set.rank2_title || '';
        if (r3) r3.value = set.rank3_title || '';
        if (ic) ic.value = set.icon || '';
        document.getElementById('quiz-set-save-btn').textContent = '수정 저장';
        document.getElementById('quiz-set-status').textContent = '문제집을 수정 중입니다.';
      });
      card.appendChild(editButton);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-btn'; button.textContent = '검토 요청';
      button.addEventListener('click', async () => {
        const res = await fetch(`/api/quiz/my-sets/${set.id}/submit`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).detail || '검토 요청 실패');
        showToast('관리자 검토를 요청했습니다.', 'success'); loadMyQuizSets();
      });
      card.appendChild(button);
    }
    list.appendChild(card);
  });
}

export async function fetchAdminQuizSubmissions() {
  const list = document.getElementById('admin-quiz-submissions-list');
  if (!list || state.currentUser?.role !== 'admin') return;
  const dailyDate = document.getElementById('quiz-daily-date');
  if (dailyDate && !dailyDate.value) {
    const koreaDateString = (offsetDays = 0) => {
      const koreaNow = new Date(Date.now() + (9 * 60 * 60 * 1000) + (offsetDays * 86400000));
      return koreaNow.toISOString().slice(0, 10);
    };
    dailyDate.value = koreaDateString(1);
    dailyDate.min = koreaDateString(0);
  }
  try {
    const res = await fetch('/api/admin/quiz/submissions');
    if (!res.ok) throw new Error('승인 목록을 불러오지 못했습니다.');
    const sets = (await res.json()).sets || []; list.replaceChildren();
    if (!sets.length) { list.textContent = '검토 대기 중인 문제집이 없습니다.'; return; }
    sets.forEach(set => {
      const card = document.createElement('details'); card.className = 'admin-submission-card';
      const summary = document.createElement('summary');
      const heading = document.createElement('span'); heading.className = 'admin-submission-heading'; heading.textContent = set.title;
      const titleExtra = set.rank1_title ? ` · 칭호: ${set.icon || ''} 🥇${set.rank1_title} 🥈${set.rank2_title || ''} 🥉${set.rank3_title || ''}` : '';
      const meta = document.createElement('span'); meta.className = 'admin-submission-meta'; meta.textContent = `${set.display_name || set.username} · ${set.expertise} · ${set.quizzes.length}문항${titleExtra}`;
      summary.append(heading, meta); card.appendChild(summary);

      const body = document.createElement('div'); body.className = 'admin-submission-body';
      const preview = document.createElement('div'); preview.className = 'admin-submission-preview';
      set.quizzes.forEach((quiz, index) => {
        const row = document.createElement('article'); row.className = 'admin-submission-question';
        const qTitle = document.createElement('strong'); qTitle.textContent = `${index + 1}. ${quiz.question}`;
        const qMeta = document.createElement('small');
        const answer = Array.isArray(quiz.correct_answers) ? quiz.correct_answers.join(', ') : '';
        qMeta.textContent = `${quiz.question_type} · ${quiz.difficulty} · 정답: ${answer}`;
        row.append(qTitle, qMeta);
        if (Array.isArray(quiz.options)) {
          const options = document.createElement('ol'); quiz.options.forEach(value => { const li = document.createElement('li'); li.textContent = value; options.appendChild(li); }); row.appendChild(options);
        }
        if (quiz.explanation) { const explanation = document.createElement('p'); explanation.textContent = `해설: ${quiz.explanation}`; row.appendChild(explanation); }
        preview.appendChild(row);
      });
      const editorLabel = document.createElement('label'); editorLabel.textContent = '최종 검토 JSON — 승인 시 이 내용이 검증·저장·게시됩니다';
      const editor = document.createElement('textarea'); editor.className = 'admin-submission-json'; editor.rows = 12; editor.value = JSON.stringify(set.quizzes, null, 2);
      const editorDetails = document.createElement('details'); editorDetails.className = 'admin-submission-editor';
      const editorSummary = document.createElement('summary'); editorSummary.textContent = '고급: JSON 직접 수정';
      editorDetails.append(editorSummary, editorLabel, editor);
      const note = document.createElement('textarea'); note.className = 'admin-review-note'; note.rows = 2; note.placeholder = '승인/반려 의견 (선택)';
      const status = document.createElement('p'); status.className = 'admin-status-msg';
      const actions = document.createElement('div'); actions.className = 'admin-review-actions';
      const validate = document.createElement('button'); validate.type = 'button'; validate.className = 'secondary-btn'; validate.textContent = '유사도·편향 검사';
      validate.addEventListener('click', async () => {
        try {
          const quizzes = JSON.parse(editor.value);
          const response = await fetch('/api/quiz/my-sets/validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expertise: set.expertise, quizzes }),
          });
          const data = await response.json(); if (!response.ok) throw new Error(data.detail || '검사 실패');
          const bias = data.answer_bias || {};
          const distribution = `①${bias.counts?.['1'] || 0} ②${bias.counts?.['2'] || 0} ③${bias.counts?.['3'] || 0} ④${bias.counts?.['4'] || 0}`;
          status.className = `admin-status-msg ${data.warnings?.length ? 'warning' : 'success'}`;
          status.textContent = data.warnings?.length
            ? `${data.warnings.join(' ')} 정답 분포 ${distribution}`
            : `검사 통과 · 정답 분포 ${distribution}`;
        } catch (err) { status.className = 'admin-status-msg error'; status.textContent = err instanceof SyntaxError ? 'JSON 형식을 확인하세요.' : err.message; }
      });
      const save = document.createElement('button'); save.type = 'button'; save.className = 'secondary-btn'; save.textContent = '수정 내용 저장';
      save.addEventListener('click', async () => {
        try {
          const quizzes = JSON.parse(editor.value);
          const response = await fetch(`/api/admin/quiz/submissions/${set.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: set.title,
              expertise: set.expertise,
              quizzes,
              rank1_title: set.rank1_title,
              rank2_title: set.rank2_title,
              rank3_title: set.rank3_title,
              icon: set.icon,
            })
          });
          const data = await response.json(); if (!response.ok) throw new Error(data.detail || '저장 실패');
          status.className = 'admin-status-msg success'; status.textContent = '수정 내용을 저장했습니다. 다시 검토한 뒤 승인하세요.';
          showToast('제출 문제집을 수정했습니다.', 'success');
        } catch (err) { status.className = 'admin-status-msg error'; status.textContent = err instanceof SyntaxError ? 'JSON 형식을 확인하세요.' : err.message; }
      });
      actions.append(validate, save);
      [['승인 및 게시', true], ['반려', false]].forEach(([label, approve]) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = approve ? 'cbt-action-btn compact' : 'danger-btn'; button.textContent = label;
        button.addEventListener('click', async () => {
          try {
            const quizzes = approve ? JSON.parse(editor.value) : undefined;
            if (approve) {
              const validationResponse = await fetch('/api/quiz/my-sets/validate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expertise: set.expertise, quizzes }),
              });
              const validation = await validationResponse.json();
              if (!validationResponse.ok) throw new Error(validation.detail || '승인 전 검사 실패');
              const warningText = validation.warnings?.length ? `\n\n주의: ${validation.warnings.join(' ')}` : '';
              if (!confirm(`${quizzes.length}개 문항을 공용 풀에 게시하시겠습니까?${warningText}`)) return;
            }
            const review = await fetch(`/api/admin/quiz/submissions/${set.id}/review`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                approve,
                note: note.value,
                title: set.title,
                expertise: set.expertise,
                quizzes,
                rank1_title: set.rank1_title,
                rank2_title: set.rank2_title,
                rank3_title: set.rank3_title,
                icon: set.icon,
              })
            });
            const data = await review.json(); if (!review.ok) throw new Error(data.detail || `${label} 실패`);
            if (data.created_ids?.length) document.getElementById('quiz-daily-ids').value = data.created_ids.join(', ');
            showToast(approve ? '승인되어 공용 풀에 추가됐습니다.' : '문제집을 반려했습니다.', 'success');
            fetchAdminQuizSubmissions(); fetchAdminQuizzes(); fetchCategoriesSummary(); loadMyQuizSets();
          } catch (err) { status.className = 'admin-status-msg error'; status.textContent = err instanceof SyntaxError ? 'JSON 형식을 확인하세요.' : err.message; }
        });
        actions.appendChild(button);
      });
      body.append(preview, editorDetails, note, status, actions); card.appendChild(body); list.appendChild(card);
    });
  } catch (err) { list.textContent = err.message; }
}

export async function openAdminQuizEditor(quiz = null) {
  const editor = document.getElementById('admin-quiz-editor');
  if (!editor) return;
  editor.classList.remove('hidden');
  document.getElementById('admin-quiz-edit-id').value = quiz?.id || '';
  const cat = quiz?.category || 'PLC';
  document.getElementById('admin-quiz-category').value = cat;
  applyTitlesToInputs(cat, 'admin-quiz-rank1', 'admin-quiz-rank2', 'admin-quiz-rank3', 'admin-quiz-icon');
  document.getElementById('admin-quiz-difficulty').value = quiz?.difficulty || 'medium';
  document.getElementById('admin-quiz-type').value = quiz?.question_type || 'multiple_choice';
  document.getElementById('admin-quiz-question').value = quiz?.question || '';
  document.getElementById('admin-quiz-options').value = Array.isArray(quiz?.options) ? quiz.options.join('\n') : '';
  document.getElementById('admin-quiz-answers').value = Array.isArray(quiz?.correct_answers) ? quiz.correct_answers.join('\n') : '';
  document.getElementById('admin-quiz-hint').value = quiz?.hint || '';
  document.getElementById('admin-quiz-source').value = quiz?.source_ref || '';
  const authorInput = document.getElementById('admin-quiz-author');
  if (authorInput) authorInput.value = quiz?.author_name || '';
  document.getElementById('admin-quiz-explanation').value = quiz?.explanation || '';
  document.getElementById('admin-quiz-editor-status').textContent = quiz ? `#${quiz.id} 문항을 수정합니다.` : '새 문항을 작성합니다.';

  const flagPanel = document.getElementById('admin-quiz-flag-panel');
  const flagBadge = document.getElementById('admin-quiz-flag-panel-badge');
  const flagItems = document.getElementById('admin-quiz-flag-items');
  if (flagPanel && flagItems) {
    if (quiz?.id && (quiz.open_flags_count > 0 || quiz.flag_summaries)) {
      flagPanel.classList.remove('hidden');
      if (flagBadge) flagBadge.textContent = `${quiz.open_flags_count || 1}건`;
      await loadQuizFlagsForEditor(quiz.id);
    } else {
      flagPanel.classList.add('hidden');
      flagItems.replaceChildren();
    }
  }

  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadQuizFlagsForEditor(quizId) {
  const flagItems = document.getElementById('admin-quiz-flag-items');
  const flagBadge = document.getElementById('admin-quiz-flag-panel-badge');
  if (!flagItems) return;
  flagItems.innerHTML = '<div style="font-size:0.8rem; color:#94a3b8; padding:6px;">신고 내역을 불러오는 중...</div>';
  try {
    const res = await fetch(`/api/admin/quiz/flags?quiz_id=${quizId}&status=open`);
    if (!res.ok) throw new Error('신고 내역을 불러오지 못했습니다.');
    const data = await res.json();
    const flags = data.flags || [];
    if (flagBadge) flagBadge.textContent = `${flags.length}건`;
    flagItems.replaceChildren();
    if (flags.length === 0) {
      flagItems.innerHTML = '<div style="font-size:0.8rem; color:#86efac; padding:6px;">접수된 미해결 신고가 없습니다.</div>';
      return;
    }
    const reasonMap = {
      wrong_answer: '정답 오류',
      typo_or_broken: '오탈자/훼손',
      bad_explanation: '해설 부실',
      other: '기타'
    };
    flags.forEach(f => {
      const row = document.createElement('div');
      row.className = 'admin-quiz-flag-row';

      const info = document.createElement('div');
      info.className = 'admin-quiz-flag-info';

      const meta = document.createElement('div');
      meta.className = 'admin-quiz-flag-meta';
      const reasonSpan = document.createElement('strong');
      reasonSpan.textContent = `[${reasonMap[f.reason_type] || f.reason_type}]`;
      const userSpan = document.createElement('span');
      userSpan.textContent = `신고자: ${f.display_name || f.username}`;
      const timeSpan = document.createElement('span');
      timeSpan.textContent = String(f.created_at || '').substring(0, 16).replace('T', ' ');
      meta.append(reasonSpan, userSpan, timeSpan);

      const commentDiv = document.createElement('div');
      commentDiv.className = 'admin-quiz-flag-comment';
      commentDiv.textContent = f.comment ? `"${f.comment}"` : '(상세 의견 없음)';

      info.append(meta, commentDiv);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      actions.style.alignItems = 'center';

      if (f.reason_type === 'wrong_answer' && f.comment) {
        const quickAddBtn = document.createElement('button');
        quickAddBtn.type = 'button';
        quickAddBtn.className = 'secondary-btn';
        quickAddBtn.style.fontSize = '0.72rem';
        quickAddBtn.style.padding = '3px 8px';
        quickAddBtn.textContent = '+ 정답 추가';
        quickAddBtn.title = '이 의견의 내용을 정답 목록에 바로 추가합니다';
        quickAddBtn.addEventListener('click', () => {
          const ansArea = document.getElementById('admin-quiz-answers');
          if (ansArea) {
            const current = ansArea.value.trim();
            const toAdd = f.comment.replace(/^["']|["']$/g, '').trim();
            ansArea.value = current ? `${current}\n${toAdd}` : toAdd;
            showToast(`'${toAdd}' 정답 후보를 추가했습니다. 저장 버튼을 눌러 확정하세요.`, 'info');
          }
        });
        actions.appendChild(quickAddBtn);
      }

      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'admin-quiz-flag-resolve-btn';
      resolveBtn.textContent = '해결 완료';
      resolveBtn.addEventListener('click', async () => {
        try {
          const rRes = await fetch(`/api/admin/quiz/flags/${f.id}/resolve`, { method: 'POST' });
          if (!rRes.ok) throw new Error('해결 처리에 실패했습니다.');
          showToast('신고를 해결 완료 처리했습니다.', 'success');
          row.remove();
          const remaining = flagItems.querySelectorAll('.admin-quiz-flag-row').length;
          if (flagBadge) flagBadge.textContent = `${remaining}건`;
          if (remaining === 0) {
            flagItems.innerHTML = '<div style="font-size:0.8rem; color:#86efac; padding:6px;">모든 신고가 해결되었습니다.</div>';
          }
          fetchAdminQuizzes();
        } catch (err) {
          showToast(err.message || '해결 처리 실패', 'error');
        }
      });
      actions.appendChild(resolveBtn);

      row.append(info, actions);
      flagItems.appendChild(row);
    });
  } catch (err) {
    flagItems.innerHTML = `<div style="font-size:0.8rem; color:#fca5a5; padding:6px;">${err.message}</div>`;
  }
}

export async function fetchAdminQuizzes() {
  const adminQuizList = document.getElementById('admin-quiz-list');
  const adminQuizTotalCount = document.getElementById('admin-quiz-total-count');
  const adminCatFilter = document.getElementById('admin-quiz-category-filter');
  if (!adminQuizList || state.currentUser?.role !== 'admin') return;

  try {
    const params = new URLSearchParams();
    if (adminQuizSearch) params.set('search', adminQuizSearch);
    if (adminQuizCategory) params.set('category', adminQuizCategory);
    if (adminQuizFlaggedOnly) params.set('flagged_only', 'true');
    params.set('limit', '300');

    const res = await fetch('/api/admin/quiz/list?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    const quizzes = data.quizzes || [];
    if (adminQuizTotalCount) adminQuizTotalCount.textContent = String(quizzes.length);

    if (adminCatFilter && Array.isArray(data.categories)) {
      const currentSelected = adminCatFilter.value;
      const existingVals = Array.from(adminCatFilter.options).map(o => o.value);
      data.categories.forEach(cat => {
        if (!existingVals.includes(cat)) {
          const opt = document.createElement('option');
          opt.value = cat;
          opt.textContent = cat;
          adminCatFilter.appendChild(opt);
        }
      });
      adminCatFilter.value = currentSelected;
    }

    adminQuizList.replaceChildren();
    if (quizzes.length === 0) {
      adminQuizList.innerHTML = '<div style="padding: 24px; text-align: center; color: #64748b;">조건에 맞는 문항이 없습니다.</div>';
      return;
    }

    quizzes.forEach(q => {
      const item = document.createElement('div');
      item.className = 'admin-quiz-item' + (q.open_flags_count > 0 ? ' has-flags' : '');

      const content = document.createElement('div');
      content.className = 'admin-quiz-item-content';

      const meta = document.createElement('div');
      meta.className = 'admin-quiz-item-meta';
      meta.innerHTML = `<strong>#${q.id}</strong> · <span class="badge">${q.category}</span> · ${q.difficulty} · ${q.question_type}`;
      if (q.author_name) meta.innerHTML += ` · 출제: ${q.author_name}`;

      if (q.open_flags_count > 0) {
        const flagIndicator = document.createElement('span');
        flagIndicator.className = 'admin-quiz-flag-indicator';
        flagIndicator.innerHTML = `⚠️ 미해결 신고 <strong>${q.open_flags_count}건</strong>`;
        flagIndicator.title = '신고 내역 확인 및 수정';
        flagIndicator.addEventListener('click', (e) => {
          e.stopPropagation();
          openAdminQuizEditor(q);
        });
        meta.appendChild(flagIndicator);
      }

      const title = document.createElement('div');
      title.className = 'admin-quiz-item-title';
      title.textContent = q.question;

      content.append(meta, title);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger-btn';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`#${q.id} 문항을 삭제하시겠습니까?`)) return;
        try {
          const dRes = await fetch(`/api/admin/quiz/${q.id}`, { method: 'DELETE' });
          if (!dRes.ok) throw new Error('삭제 실패');
          showToast('문항이 삭제되었습니다.', 'success');
          fetchAdminQuizzes();
          fetchCategoriesSummary();
        } catch (err) {
          showToast(err.message || '삭제 실패', 'error');
        }
      });

      const actions = document.createElement('div');
      actions.className = 'admin-quiz-item-actions';
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      actions.style.alignItems = 'center';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = q.open_flags_count > 0 ? 'cbt-action-btn compact' : 'secondary-btn';
      editBtn.textContent = q.open_flags_count > 0 ? '신고 확인·수정' : '수정';
      editBtn.addEventListener('click', () => openAdminQuizEditor(q));

      actions.append(editBtn, delBtn);
      item.append(content, actions);
      adminQuizList.appendChild(item);
    });
  } catch { /* admin fetch error */ }
}

export function openQuizFlagModal(quiz) {
  if (!quiz) return;
  currentFlagTargetQuiz = quiz;
  const modal = document.getElementById('quiz-flag-modal');
  const targetBadge = document.getElementById('quiz-flag-target-badge');
  const targetText = document.getElementById('quiz-flag-target-text');
  const commentInput = document.getElementById('quiz-flag-comment');
  const statusMsg = document.getElementById('quiz-flag-status');

  if (targetBadge) targetBadge.textContent = `#${quiz.id}`;
  if (targetText) targetText.textContent = quiz.question || '';
  if (commentInput) commentInput.value = '';
  if (statusMsg) {
    statusMsg.textContent = '';
    statusMsg.className = 'admin-status-msg';
  }

  const defaultRadio = document.querySelector('input[name="quiz-flag-reason"][value="wrong_answer"]');
  if (defaultRadio) defaultRadio.checked = true;

  modal?.classList.remove('hidden');
}

export function closeQuizFlagModal() {
  const modal = document.getElementById('quiz-flag-modal');
  modal?.classList.add('hidden');
  currentFlagTargetQuiz = null;
}

export async function submitQuizFlag(e) {
  e.preventDefault();
  if (!currentFlagTargetQuiz) return;
  const statusMsg = document.getElementById('quiz-flag-status');
  const submitBtn = document.getElementById('quiz-flag-submit-btn');
  const reasonRadio = document.querySelector('input[name="quiz-flag-reason"]:checked');
  const reason_type = reasonRadio ? reasonRadio.value : 'wrong_answer';
  const comment = (document.getElementById('quiz-flag-comment')?.value || '').trim();

  if (submitBtn) submitBtn.disabled = true;
  if (statusMsg) {
    statusMsg.textContent = '신고를 접수하는 중...';
    statusMsg.className = 'admin-status-msg';
  }

  try {
    const res = await fetch(`/api/quiz/${currentFlagTargetQuiz.id}/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason_type, comment })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '신고 접수에 실패했습니다.');

    showToast('문제 오류 신고가 접수되었습니다. 관리자가 검토 후 즉시 반영합니다.', 'success');
    closeQuizFlagModal();
  } catch (err) {
    if (statusMsg) {
      statusMsg.textContent = err.message || '신고 접수 중 오류가 발생했습니다.';
      statusMsg.className = 'admin-status-msg error';
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
