// CSV uploads and spreadsheet pastes share the same preview contract.
export function parseRoster(source) {
  if (source.length > 100000) throw new Error('명단은 100KB 이하로 입력해 주세요.');
  const text = source.replace(/^\uFEFF/, '');
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const table = []; let row = [], cell = '', quoted = false, closed = false;
  const field = () => { row.push(cell); cell = ''; closed = false; };
  const line = () => { field(); if (row.some(v => v.trim())) table.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === delimiter) field();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; line(); }
    else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === '"' || closed) throw new Error('따옴표 형식을 확인해 주세요. CSV에서 따옴표는 두 번 입력합니다.');
    else cell += ch;
  }
  if (quoted) throw new Error('닫히지 않은 따옴표가 있습니다.');
  line();
  const headers = (table.shift() || []).map(v => v.trim());
  if (!headers.includes('username') || !headers.includes('display_name') || new Set(headers).size !== headers.length || headers.some(h => !['username', 'display_name', 'role'].includes(h))) throw new Error('첫 행은 username,display_name,role 형식이어야 합니다. role은 생략할 수 있습니다.');
  if (!table.length || table.length > 100) throw new Error('한 번에 1~100명까지 가져올 수 있습니다.');
  return table.map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`${i + 2}행의 열 개수를 확인해 주세요.`);
    const data = Object.fromEntries(headers.map((h, index) => [h, cells[index].trim()]));
    data.role = ({ '수강생': 'student', '학생': 'student', '강사': 'instructor' })[data.role] || data.role || 'student';
    return data;
  });
}

export function credentialsCsv(credentials, { spreadsheetSafe = true } = {}) {
  const cell = value => '"' + (spreadsheetSafe ? String(value).replace(/^[=+@-]/, "'$&") : String(value)).replaceAll('"', '""') + '"';
  return '\uFEFF' + [['username', 'display_name', 'temporary_password'], ...credentials.map(c => [c.username, c.display_name, c.temporary_password])].map(row => row.map(cell).join(',')).join('\r\n');
}
