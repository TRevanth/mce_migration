import { useState } from 'react';
import { api } from '../api.js';

export default function Connect({ status, refresh, next }) {
  const [form, setForm] = useState({ subdomain: '', clientId: '', clientSecret: '', accountId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function connect(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.connectMce(form); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid2">
      <section className="card">
        <h2>1. Marketing Cloud Engagement {status.mce && <span className="ok">Connected</span>}</h2>
        <p className="hint">Use an installed package of type API Integration (server-to-server) with Data Extensions read access. The subdomain is the part after <code>auth.</code> in your auth base URI.</p>
        <form onSubmit={connect}>
          <label>Subdomain<input value={form.subdomain} onChange={set('subdomain')} placeholder="mc1234abcd5678" required /></label>
          <label>Client ID<input value={form.clientId} onChange={set('clientId')} required /></label>
          <label>Client secret<input type="password" value={form.clientSecret} onChange={set('clientSecret')} required /></label>
          <label>Account ID (MID, optional)<input value={form.accountId} onChange={set('accountId')} /></label>
          <button disabled={busy}>{busy ? 'Testing...' : status.mce ? 'Reconnect' : 'Connect'}</button>
          {error && <p className="error">{error}</p>}
        </form>
      </section>

      <section className="card">
        <h2>2. Salesforce org (Data Cloud) {status.salesforce && <span className="ok">Connected</span>}</h2>
        <p className="hint">Needed to create data streams. You can do the earlier steps without it.</p>
        {status.salesforce ? <p>Connected to <code>{status.sfInstance}</code></p> : <a className="btn" href="/api/sf/login">Log in with Salesforce</a>}
      </section>

      <div className="actions">
        <button disabled={!status.mce} onClick={next}>Next: discover Data Extensions</button>
      </div>
    </div>
  );
}
