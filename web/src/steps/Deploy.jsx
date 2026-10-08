import { useState } from 'react';
import { api } from '../api.js';

export default function Deploy({ built, status }) {
  const [connector, setConnector] = useState('');
  const [results, setResults] = useState([]);
  const [verify, setVerify] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadResults, setLoadResults] = useState([]);
  const valid = built.schemas.filter((s) => s.valid);

  function download() {
    const url = URL.createObjectURL(new Blob([built.yaml], { type: 'text/yaml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'ingestion-schema.yaml' });
    a.click(); URL.revokeObjectURL(url);
  }

  async function create() {
    setBusy(true); setError('');
    try { setResults((await api.createStreams(connector, valid)).results); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function load() {
    setLoading(true); setLoadError(''); setLoadResults([]);
    try { setLoadResults((await api.loadData(connector, valid, Number(limit))).results); }
    catch (e) { setLoadError(e.message); }
    finally { setLoading(false); }
  }

  async function check(name) {
    let message;
    try { message = (await api.verify(name)).found ? 'Data stream found' : 'Not found yet'; }
    catch (e) { message = e.message; }
    setVerify((v) => ({ ...v, [name]: message }));
  }

  return (
    <div>
      <section className="card">
        <h2>1. Upload the schema to your Ingestion API connector</h2>
        <p className="hint">In Data Cloud Setup, open Ingestion API, choose your connector, and upload this file as the schema. This step is done in the Salesforce UI.</p>
        <pre className="yaml">{built.yaml}</pre>
        <button onClick={download}>Download YAML</button>
      </section>

      <section className="card">
        <h2>2. Create data streams</h2>
        {!status.salesforce && <p className="error">Log in to Salesforce on the Connect step to create streams from here. Otherwise follow the manual steps shown below after clicking Create.</p>}
        <label>Ingestion API connector name<input value={connector} onChange={(e) => setConnector(e.target.value)} placeholder="MCE_Migration" /></label>
        <button disabled={!connector || !valid.length || busy} onClick={create}>{busy ? 'Creating...' : `Create ${valid.length} data stream${valid.length === 1 ? '' : 's'}`}</button>
        {error && <p className="error">{error}</p>}

        {results.map((r) => (
          <div key={r.object} className="result">
            <h3>{r.object} <span className={r.status === 'created' ? 'ok' : 'bad'}>{r.status === 'created' ? 'Created' : 'Finish in the UI'}</span></h3>
            {r.status === 'manual' && (
              <>
                <p className="hint">Salesforce did not accept the API request (HTTP {r.httpStatus}). Do this in Data Cloud instead:</p>
                <ol>{r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </>
            )}
            <button onClick={() => check(r.object)}>Verify</button> {verify[r.object] && <span>{verify[r.object]}</span>}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>3. Load data</h2>
        <p className="hint">Copies rows from each Data Extension into its data stream through the Ingestion API. The data stream must already be deployed with the connector name above. Try a small test load first.</p>
        {!status.salesforce && <p className="error">Log in to Salesforce on the Connect step first.</p>}
        <label>Max rows per Data Extension (blank = all)<input type="number" min="1" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 10" /></label>
        <button disabled={!connector || !valid.length || !status.salesforce || loading} onClick={load}>{loading ? 'Loading...' : 'Load data'}</button>
        {loadError && <p className="error">{loadError}</p>}
        {loadResults.map((r) => (
          <div key={r.object} className="result">
            <h3>{r.object} <span className={r.status === 'loaded' ? 'ok' : 'bad'}>{r.status === 'loaded' ? 'Loaded' : 'Failed'}</span></h3>
            <p>{r.sent} rows sent{r.total != null ? ` (DE has ${r.total})` : ''}.{r.error && <span className="error"> {r.error}</span>}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
