// Thin API client for the worker's loopback endpoints. In a static export no network is used.
export function createApi({ staticSnapshot = null } = {}) {
  let csrf = null;
  async function call(method, url, body) {
    const headers = { accept: 'application/json' };
    if (method === 'POST') {
      if (!csrf) csrf = (await (await fetch('/v1/csrf', { credentials: 'same-origin' })).json()).csrf;
      headers['content-type'] = 'application/json';
      headers['x-tracker-csrf'] = csrf;
    }
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 401) { const e = new Error('Owner session expired; run `tracker ui` again'); e.code = 'unauthenticated'; e.status = 401; throw e; }
    if (!res.ok) { const e = new Error(data && data.error ? data.error.message : `HTTP ${res.status}`); e.code = data && data.error ? data.error.code : `http-${res.status}`; e.status = res.status; e.data = data; throw e; }
    return data;
  }
  if (staticSnapshot) {
    return {
      static: true,
      getSnapshot: async () => staticSnapshot,
      getTicket: async (id) => staticSnapshot.tickets.find((t) => t.id === id) ?? null,
      getContent: async () => null,
      submit: async () => { throw new Error('This is a read-only snapshot; nothing can be submitted.'); },
      cancel: async () => { throw new Error('read-only snapshot'); },
      getRequest: async () => null,
      exportPreview: async () => null,
      exportRun: async () => null,
    };
  }
  return {
    static: false,
    getSnapshot: () => call('GET', '/v1/snapshot'),
    getTicket: (id, generation) => call('GET', `/v1/tickets/${encodeURIComponent(id)}?generation=${encodeURIComponent(generation)}`),
    getContent: async (hash, generation) => {
      const res = await fetch(`/v1/content/${encodeURIComponent(hash)}?generation=${encodeURIComponent(generation)}`, { credentials: 'same-origin' });
      if (res.status === 410) { const e = new Error('generation expired'); e.code = 'generation-expired'; throw e; }
      if (!res.ok) return null;
      return res.text();
    },
    submit: (body) => call('POST', '/v1/requests', body),
    cancel: (id) => call('POST', `/v1/requests/${encodeURIComponent(id)}/cancel`, {}),
    getRequest: (id) => call('GET', `/v1/requests/${encodeURIComponent(id)}`),
    exportPreview: (params) => call('GET', `/v1/export/preview?${new URLSearchParams(params)}`),
    exportRun: (body) => call('POST', '/v1/export', body),
  };
}

export function uuidv4() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
