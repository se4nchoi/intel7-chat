export const MAX_QUESTION_FILES = 5;
export const MAX_QUESTION_FILE_BYTES = 10 * 1024 * 1024;
const BLOCKED_SUFFIXES = new Set(['app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe', 'hta', 'htm', 'html', 'jar', 'js', 'jse', 'lnk', 'mjs', 'msi', 'msp', 'pif', 'ps1', 'reg', 'scr', 'svg', 'vbe', 'vbs', 'wsf', 'wsh']);

export function questionFileError(files) {
  if (files.length > MAX_QUESTION_FILES) return '첨부파일은 최대 5개까지 선택할 수 있습니다.';
  if (files.some(file => !file.size || file.size > MAX_QUESTION_FILE_BYTES)) return '첨부파일은 각각 1바이트~10MB까지 가능합니다.';
  if (files.some(file => BLOCKED_SUFFIXES.has((file.name || '').split('.').pop()?.toLowerCase()))) return '실행 파일·웹 페이지는 첨부할 수 없습니다.';
  return '';
}

export function mergeQuestionFiles(selected, incoming) {
  const seen = new Set(selected.map(file => `${file.name}\0${file.size}\0${file.lastModified}`));
  const result = [...selected];
  for (const file of incoming) {
    const key = `${file.name}\0${file.size}\0${file.lastModified}`;
    if (!seen.has(key)) { result.push(file); seen.add(key); }
  }
  return result;
}

export function formatFileSize(bytes) {
  return !bytes ? '0 B' : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function insertCodeFence(text, start, end) {
  const selected = text.slice(start, end);
  const prefix = start && text[start - 1] !== '\n' ? '\n' : '';
  const suffix = end < text.length && text[end] !== '\n' ? '\n' : '';
  const code = `${prefix}\`\`\`\n${selected || '코드를 입력하세요'}\n\`\`\`${suffix}`;
  return { value: text.slice(0, start) + code + text.slice(end), start: start + prefix.length + 4, end: start + prefix.length + 4 + (selected || '코드를 입력하세요').length };
}
