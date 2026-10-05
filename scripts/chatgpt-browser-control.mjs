export async function requestChatgptBrowserOpen(details, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch.');
  if (!details?.localStatusUrl) throw new Error('No local CodexPro status URL is available for this run.');
  const endpoint = new URL('/admin/chatgpt-browser/open', details.localStatusUrl);
  if (details.token) endpoint.searchParams.set('codexpro_token', details.token);
  const response = await fetchImpl(endpoint, { method: 'POST' });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const message = payload?.message || payload?.error?.message || `ChatGPT browser control failed with HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload;
}
