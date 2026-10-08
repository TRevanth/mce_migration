async function request(path, init) {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  status: () => request('/status'),
  connectMce: (body) => request('/mce/connect', { method: 'POST', body }),
  disconnect: () => request('/disconnect', { method: 'POST' }),
  listDes: () => request('/des'),
  getDe: (id) => request(`/des/${id}`),
  buildSchema: (des) => request('/schema', { method: 'POST', body: { des } }),
  createStreams: (connectorName, schemas) => request('/stream', { method: 'POST', body: { connectorName, schemas } }),
  loadData: (connectorName, schemas, limit) => request('/load', { method: 'POST', body: { connectorName, schemas, limit: limit || undefined } }),
  agentChat: (message) => request('/agent/chat', { method: 'POST', body: { message } }),
  agentApprove: (id, approve) => request('/agent/approve', { method: 'POST', body: { id, approve } }),
  agentReset: () => request('/agent/reset', { method: 'POST' }),
  verify: (name) => request(`/stream/verify?name=${encodeURIComponent(name)}`),
};
