export function waitingAge(createdAt, now = Date.now()) {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60000));
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 1) return '방금 등록';
  if (elapsed < 60) return `${elapsed}분째 대기`;
  if (elapsed < 1440) return `${Math.floor(elapsed / 60)}시간째 대기`;
  return `${Math.floor(elapsed / 1440)}일째 대기`;
}

export function nextQueueQuestion(questions, currentId) {
  const index = questions.findIndex(question => question.id === currentId);
  return questions[index < 0 ? 0 : index + 1] || null;
}
