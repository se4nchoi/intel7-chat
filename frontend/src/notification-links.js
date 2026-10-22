import { spaceUrl } from './navigation.js';

export function notificationUrl(item) {
  if (!item.cohort_slug) throw new Error('알림의 수강반을 찾을 수 없습니다.');
  if (item.kind === 'answer' && Number.isSafeInteger(item.question_id) && item.question_id > 0 && Number.isSafeInteger(item.answer_id) && item.answer_id > 0) return `${spaceUrl(item.cohort_slug, 'board')}?answer=${item.answer_id}#post-${item.question_id}`;
  if (item.kind === 'mention' && Number.isSafeInteger(item.channel_id) && item.channel_id > 0 && Number.isSafeInteger(item.message_id) && item.message_id > 0) return `${spaceUrl(item.cohort_slug, 'chat')}?channel=${item.channel_id}#message-${item.message_id}`;
  throw new Error('알림의 대상을 찾을 수 없습니다.');
}

export function readAnswerTarget(search, hash) {
  const match = /^#post-(\d+)$/.exec(hash);
  const questionId = match ? Number(match[1]) : null;
  const rawAnswerId = new URLSearchParams(search).get('answer');
  const answerId = rawAnswerId && /^\d+$/.test(rawAnswerId) ? Number(rawAnswerId) : null;
  return {
    questionId: Number.isSafeInteger(questionId) && questionId > 0 ? questionId : null,
    answerId: Number.isSafeInteger(questionId) && questionId > 0 && Number.isSafeInteger(answerId) && answerId > 0 ? answerId : null,
  };
}
