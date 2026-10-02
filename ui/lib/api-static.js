// Read-only API used inside exported snapshots: no network, no endpoints, no credentials.
export function createApi({ staticSnapshot = null } = {}) {
  const snapshot = staticSnapshot ?? (typeof window !== 'undefined' ? window.__SNAPSHOT__ : null);
  const refuse = async () => { throw new Error('This is a read-only snapshot; nothing can be submitted.'); };
  return {
    static: true,
    getSnapshot: async () => snapshot,
    getTicket: async (id) => (snapshot ? snapshot.tickets.find((t) => t.id === id) ?? null : null),
    getContent: async () => null,
    submit: refuse,
    cancel: refuse,
    getRequest: async () => null,
    exportPreview: refuse,
    exportRun: refuse,
  };
}

export function uuidv4() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-0000-4000-8000-000000000000`;
}
