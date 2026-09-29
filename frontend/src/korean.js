const messages = {
  'Invalid origin': '허용되지 않은 접속 경로입니다. 원래 페이지에서 다시 시도하세요.',
  'Log in to the prototype hub': '로그인이 필요합니다.',
  'No access to this cohort': '이 수강반에 접근할 권한이 없습니다.',
  'Instructor access required': '강사 권한이 필요합니다.',
  'This cohort is archived': '종료된 수강반은 내용을 변경할 수 없습니다.',
  'PostgreSQL unavailable': '서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
  'Incorrect username or password': '아이디 또는 비밀번호가 올바르지 않습니다.',
  'Too many login attempts; try again later': '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
  'Administrator access required': '관리자 권한이 필요합니다.',
  'Cohort slug already exists': '이미 사용 중인 수강반 주소 ID입니다.',
  'Username already exists': '이미 사용 중인 아이디입니다.',
  'Only an administrator can assign instructors': '강사 지정은 관리자만 할 수 있습니다.',
  'Account not found': '계정을 찾을 수 없습니다.',
  'Channel slug already exists': '이미 사용 중인 채널 주소 ID입니다.',
  'Channel not found': '채널을 찾을 수 없습니다.',
  'Local SFU is not configured': '화면 공유 서비스가 아직 준비되지 않았습니다.',
  'Message cannot be empty': '메시지를 입력해 주세요.',
  'Question title and body are required': '질문 제목과 내용을 모두 입력해 주세요.',
  'Question not found': '질문을 찾을 수 없습니다.',
  'Answer cannot be empty': '답변을 입력해 주세요.',
  'Unsupported file type': '지원하지 않는 파일 형식입니다. 문서, 이미지 또는 텍스트 파일을 선택하세요.',
  'Files must be between 1 byte and 10 MB': '빈 파일은 올릴 수 없으며 파일 크기는 최대 10MB입니다.',
  'File not found': '파일을 찾을 수 없습니다.',
  'Answer not found': '답변을 찾을 수 없습니다.',
  'You cannot deactivate your own account': '본인 계정은 비활성화할 수 없습니다.',
  'Change your own password from your account menu': '본인 비밀번호는 계정 메뉴에서 변경하세요.',
  'Current password is incorrect': '현재 비밀번호가 올바르지 않습니다.',
  'Cohort not found': '수강반을 찾을 수 없습니다.',
  'You cannot remove yourself from a cohort': '본인을 수강반에서 내보낼 수 없습니다.',
  'Member not found': '구성원을 찾을 수 없습니다.',
  'Message not found': '메시지를 찾을 수 없습니다.',
  'You can only delete your own posts': '본인이 작성한 글만 삭제할 수 있습니다.',
  'You can only edit your own posts': '본인이 작성한 글만 수정할 수 있습니다.',
  'Text cannot be empty': '내용을 입력해 주세요.',
  'Unsupported reaction': '사용할 수 없는 반응입니다.',
  'You cannot message yourself': '자기 자신에게는 DM을 보낼 수 없습니다.',
  'Channel IDs starting with dm- are reserved': '채널 주소 ID는 dm-으로 시작할 수 없습니다.',
  'Only an administrator can remove instructors': '강사를 내보내는 것은 관리자만 할 수 있습니다.',
};
const fields = {username:'아이디', password:'비밀번호', display_name:'표시 이름', slug:'주소 ID', name:'이름', role:'역할', title:'질문 제목', body:'내용', upload:'파일', current_password:'현재 비밀번호', new_password:'새 비밀번호'};
export function errorMessage(detail, status) {
  if (Array.isArray(detail)) {
    return detail.map(issue => {
      const field = fields[issue.loc?.at(-1)] || '입력값';
      if (issue.type === 'missing') return `${field}을(를) 입력해 주세요.`;
      if (issue.type === 'string_too_short') return `${field}은(는) ${issue.ctx?.min_length}자 이상 입력해 주세요.`;
      if (issue.type === 'string_too_long') return `${field}은(는) ${issue.ctx?.max_length}자 이하로 입력해 주세요.`;
      if (issue.type === 'string_pattern_mismatch' && issue.loc?.at(-1) === 'slug') return '주소 ID는 영문 소문자·숫자로 시작하고, 영문 소문자·숫자·하이픈만 사용할 수 있습니다. 길이도 확인해 주세요.';
      return `${field}의 입력 형식을 확인해 주세요.`;
    }).join(' ');
  }
  if (typeof detail === 'string') {
    if (messages[detail]) return messages[detail];
    if (/[가-힣]/.test(detail)) return detail;
    if (/denied|permission|notallowed|cancel/i.test(detail)) return '화면 공유가 취소되었거나 권한이 허용되지 않았습니다. 공유할 화면을 선택하고 권한을 허용해 주세요.';
    if (/fetch|network|connection|connect|signal/i.test(detail)) return '연결할 수 없습니다. 네트워크 상태를 확인하고 다시 시도하세요.';
  }
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (status === 403) return '이 작업을 수행할 권한이 없습니다.';
  if (status === 413) return '파일 용량이 너무 큽니다. 10MB 이하의 파일을 선택하세요.';
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}

// Browser-native validation messages otherwise follow the browser's language.
export function installKoreanValidation(root = document) {
  root.addEventListener('input', event => event.target.setCustomValidity?.(''));
  root.addEventListener('change', event => event.target.setCustomValidity?.(''));
  root.addEventListener('invalid', event => {
    const input = event.target;
    input.setCustomValidity('');
    if (input.validity.valueMissing) input.setCustomValidity(input.type === 'file' ? '파일을 선택해 주세요.' : '필수 항목을 입력해 주세요.');
    else if (input.validity.tooShort) input.setCustomValidity(`${input.minLength}자 이상 입력해 주세요.`);
    else if (input.validity.tooLong) input.setCustomValidity(`${input.maxLength}자 이하로 입력해 주세요.`);
    else if (!input.validity.valid) input.setCustomValidity('입력 형식을 확인해 주세요.');
  }, true);
}
