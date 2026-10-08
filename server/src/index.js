import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { createMceClient } from './mce/client.js';
import { buildAuthorizeUrl, exchangeCode, createDataStream, findDataStream } from './sf/client.js';
import { buildSchema } from './mapper/schema.js';
import { toOpenApiYaml } from './mapper/yaml.js';
import { loadSchema } from './load.js';
import { chat as agentChat, decide as agentDecide, newAgentState } from './agent/loop.js';

const PORT = process.env.PORT || 3001;
const WEB_URL = process.env.WEB_URL || 'http://localhost:5173';
const sfConfig = () => ({
  loginUrl: (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, ''),
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_REDIRECT_URI || `http://localhost:${PORT}/api/sf/callback`,
});

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(`[api] ${req.method} ${req.originalUrl} failed:`, e.message); res.status(500).json({ error: e.message }); });
// Session credentials win; otherwise fall back to MCE_* env vars so dev doesn't need the Connect form.
const envMceCreds = () => process.env.MCE_SUBDOMAIN && process.env.MCE_CLIENT_ID && process.env.MCE_CLIENT_SECRET
  ? { subdomain: process.env.MCE_SUBDOMAIN, clientId: process.env.MCE_CLIENT_ID, clientSecret: process.env.MCE_CLIENT_SECRET, accountId: process.env.MCE_ACCOUNT_ID || undefined }
  : null;
const mceCreds = (req) => req.session.mceCreds ?? envMceCreds();
const mce = (req) => {
  const creds = mceCreds(req);
  if (!creds) throw new Error('Not connected to Marketing Cloud Engagement');
  return (req.mceClient ??= createMceClient(creds, (req.session.mceCache ??= {})));
};

// ---- Connect ---------------------------------------------------------------
app.get('/api/status', (req, res) => res.json({ mce: !!mceCreds(req), salesforce: !!req.session.sf, sfInstance: req.session.sf?.instanceUrl ?? null, agent: !!process.env.ANTHROPIC_API_KEY }));

app.post('/api/mce/connect', wrap(async (req, res) => {
  const { subdomain, clientId, clientSecret, accountId } = req.body ?? {};
  if (!subdomain || !clientId || !clientSecret) return res.status(400).json({ error: 'subdomain, clientId and clientSecret are required' });
  const creds = { subdomain: String(subdomain).trim(), clientId, clientSecret, accountId };
  const info = await createMceClient(creds, (req.session.mceCache = {})).test();
  req.session.mceCreds = creds;
  res.json({ connected: true, ...info });
}));

app.get('/api/sf/login', (req, res) => {
  const cfg = sfConfig();
  if (!cfg.clientId) return res.status(500).json({ error: 'SF_CLIENT_ID is not configured on the server' });
  res.redirect(buildAuthorizeUrl(cfg, req.session));
});

app.get('/api/sf/callback', wrap(async (req, res) => {
  await exchangeCode(sfConfig(), req.session, req.query.code, req.query.state);
  res.redirect(WEB_URL);
}));

app.post('/api/disconnect', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---- Discover --------------------------------------------------------------
app.get('/api/des', wrap(async (req, res) => res.json(await mce(req).listDataExtensions())));

app.get('/api/des/:id', wrap(async (req, res) => {
  const client = mce(req);
  console.log(`[api] GET /api/des/${req.params.id}`);
  const [fields, rowCount] = await Promise.all([client.getFields(req.params.id), client.getRowCount(req.params.id).catch((e) => { console.log('[api] rowCount failed:', e.message); return null; })]);
  console.log(`[api] -> ${fields.length} fields, rowCount=${rowCount}`);
  res.json({ id: req.params.id, fields, rowCount });
}));

// ---- Schema + YAML ---------------------------------------------------------
// body: { des: [{ key, name, fields, options: { primaryKey, syntheticKey, category, eventTimeField } }] }
app.post('/api/schema', (req, res) => {
  const schemas = (req.body?.des ?? []).map((d) => ({ key: d.key, ...buildSchema(d, d.options) }));
  res.json({ schemas, yaml: toOpenApiYaml(schemas.filter((s) => s.valid)), allValid: schemas.every((s) => s.valid) });
});

// ---- Data stream -----------------------------------------------------------
// body: { connectorName, schemas: [built schemas] }. Falls back to guided steps when the API can't create it.
app.post('/api/stream', wrap(async (req, res) => {
  const { connectorName, schemas = [] } = req.body ?? {};
  if (!connectorName) return res.status(400).json({ error: 'connectorName is required' });
  const results = [];
  for (const s of schemas.filter((x) => x.valid)) {
    const r = await createDataStream(req.session, { connectorName, ...s });
    results.push(r.ok
      ? { object: s.objectName, status: 'created', response: r.body }
      : { object: s.objectName, status: 'manual', httpStatus: r.status, detail: r.body,
          steps: [
            `Data Cloud > Data Streams > New > Ingestion API > select connector "${connectorName}".`,
            `Choose object "${s.objectName}" (upload the generated YAML to the connector first if it is missing).`,
            `Set category "${s.category}", primary key "${s.primaryKey}"${s.eventTimeField ? `, event time "${s.eventTimeField}"` : ''}.`,
            'Deploy, then use Verify in this app.',
          ] });
  }
  res.json({ results });
}));

// ---- Load data -------------------------------------------------------------
// body: { connectorName, schemas: [built schemas with key], limit?: number (max rows per DE, for test loads) }
app.post('/api/load', wrap(async (req, res) => {
  const { connectorName, schemas = [], limit } = req.body ?? {};
  if (!connectorName) return res.status(400).json({ error: 'connectorName is required' });
  const client = mce(req);
  const results = [];
  for (const schema of schemas.filter((x) => x.valid)) results.push(await loadSchema({ session: req.session, client, schema, connectorName, limit }));
  res.json({ results });
}));

app.get('/api/stream/verify', wrap(async (req, res) => {
  const r = await findDataStream(req.session, req.query.name);
  const list = r.body?.dataStreams ?? [];
  const match = list.filter((d) => (d.name ?? '').toLowerCase().startsWith(String(req.query.name ?? '').toLowerCase()));
  res.json({ ok: r.ok, found: match.length > 0, matches: match, raw: r.ok ? undefined : r.body });
}));

// ---- Agent -----------------------------------------------------------------
// Chat with the migration agent. Write tools pause for approval: the response carries `pending`, then POST /api/agent/approve.
const agentCtx = (req) => ({ state: (req.session.agent ??= newAgentState()), session: req.session, getClient: () => mce(req) });
const agentWrap = (fn) => wrap(async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
});

app.post('/api/agent/chat', agentWrap((req) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) throw Object.assign(new Error('message is required'), { status: 400 });
  return agentChat({ ...agentCtx(req), message });
}));

app.post('/api/agent/approve', agentWrap((req) => agentDecide({ ...agentCtx(req), id: req.body?.id, approve: !!req.body?.approve })));

app.post('/api/agent/reset', (req, res) => { delete req.session.agent; res.json({ ok: true }); });

app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
