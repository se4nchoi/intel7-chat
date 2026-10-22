// Preview text is inserted with textContent, never interpreted as HTML.
export function plainExcerpt(value, limit = 180) {
  const source = String(value ?? '');
  const plain = source
    .replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_match, language, code) => ` 코드${language ? ` (${language})` : ''}: ${code.trim()} `)
    .replace(/```[\w+#.-]*[ \t]*\n?/g, ' 코드: ')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|\n)\s*(?:>\s?|[-*]\s+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}
