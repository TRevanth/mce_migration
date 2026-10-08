import crypto from 'node:crypto';

// Salesforce OAuth 2.0 Web Server flow with PKCE, plus Data Cloud calls.
const API_VERSION = 'v62.0';
const b64url = (buf) => buf.toString('base64url');

export function buildAuthorizeUrl({ loginUrl, clientId, redirectUri }, session) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  session.sfPkce = { verifier, state: b64url(crypto.randomBytes(16)), loginUrl };
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: session.sfPkce.state,
    scope: 'api refresh_token cdp_ingest_api cdp_profile_api cdp_query_api',
  });
  return `${loginUrl}/services/oauth2/authorize?${q}`;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri }, session, code, state) {
  const p = session.sfPkce;
  if (!p || p.state !== state) throw new Error('OAuth state mismatch');
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: p.verifier,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  const res = await fetch(`${p.loginUrl}/services/oauth2/token`, { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Salesforce token exchange failed');
  delete session.sfPkce;
  session.sf = { accessToken: data.access_token, instanceUrl: data.instance_url, identity: data.id };
}

export async function sfFetch(session, path, init = {}) {
  if (!session.sf) throw new Error('Not connected to Salesforce');
  const res = await fetch(`${session.sf.instanceUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.sf.accessToken}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

export const sfApi = (p) => `/services/data/${API_VERSION}${p}`;

// Data stream creation. The request body for Ingestion API streams is the least
// certain part of the plan: confirm it in the day 1-2 spike. When Salesforce
// rejects it, the route falls back to the guided UI checklist instead of failing.
export async function createDataStream(session, { connectorName, objectName, primaryKey, category, eventTimeField }) {
  const payload = {
    label: objectName, name: objectName, dataStreamType: 'INGESTAPI',
    connectorInfo: { connectorType: 'IngestApi', connectorDetails: { name: connectorName, sourceObject: objectName } },
    dataLakeObjectInfo: {
      label: objectName, name: objectName, category,
      primaryKeyFieldName: primaryKey, ...(eventTimeField ? { recordModifiedFieldName: eventTimeField } : {}),
    },
  };
  return sfFetch(session, sfApi('/ssot/data-streams'), { method: 'POST', body: JSON.stringify(payload) });
}

// Ingestion API calls go to a Data Cloud tenant endpoint, so the core access token is exchanged first.
async function getDataCloudToken(session) {
  if (!session.sf) throw new Error('Not connected to Salesforce');
  const dc = session.sf.dc;
  if (dc && dc.expiresAt > Date.now()) return dc;
  const res = await fetch(`${session.sf.instanceUrl}/services/a360/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:salesforce:grant-type:external:cdp',
      subject_token: session.sf.accessToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[sf] data cloud token exchange -> ${res.status}`, res.ok ? { instance: data.instance_url } : data);
  if (!res.ok) throw new Error(data.error_description || data.message || `Data Cloud token exchange failed (${res.status})`);
  return (session.sf.dc = { accessToken: data.access_token, instanceUrl: `https://${data.instance_url.replace(/^https?:\/\//, '')}`, expiresAt: Date.now() + ((data.expires_in ?? 7200) - 60) * 1000 });
}

// Streaming ingestion: up to 200 records per request.
export async function ingestRecords(session, connectorName, objectName, records) {
  const dc = await getDataCloudToken(session);
  const url = `${dc.instanceUrl}/api/v1/ingest/sources/${encodeURIComponent(connectorName)}/${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dc.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: records }),
  });
  const text = await res.text();
  console.log(`[sf] ingest ${objectName}: ${records.length} records -> ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`Ingestion failed (${res.status}): ${text.slice(0, 300)}`);
}

export async function findDataStream(session, name) {
  return sfFetch(session, sfApi(`/ssot/data-streams?limit=200`));
}
