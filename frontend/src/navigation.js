// Public UI routes. Infrastructure addresses belong in the API adapter/configuration.
export function readRoute(pathname) {
  const match = pathname.match(/^\/hub\/cohorts\/([^/]+)\/(chat|board)\/?$/);
  if (!match) return { slug: null, space: 'chat' };
  try { return { slug: decodeURIComponent(match[1]), space: match[2] }; }
  catch { return { slug: null, space: 'chat' }; }
}
export function spaceUrl(slug, space) {
  if (!['chat', 'board'].includes(space)) throw new Error('Unknown learning space');
  return `/hub/cohorts/${encodeURIComponent(slug)}/${space}`;
}
