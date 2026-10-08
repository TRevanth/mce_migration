import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Discover({ selected, setSelected, next }) {
  const [des, setDes] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState(() => new Set(selected.map((s) => s.id)));

  useEffect(() => {
    api.listDes().then(setDes).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const shown = des.filter((d) => `${d.name} ${d.key}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function load() {
    setBusy(true); setError('');
    try {
      const chosen = des.filter((d) => picked.has(d.id));
      const detailed = await Promise.all(chosen.map(async (d) => ({ ...d, ...(await api.getDe(d.id)) })));
      setSelected(detailed);
      next();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2>Data Extensions</h2>
      <input className="search" placeholder="Search by name or key" value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th></th><th>Name</th><th>Key</th><th>Sendable</th></tr></thead>
        <tbody>
          {shown.map((d) => (
            <tr key={d.id} onClick={() => toggle(d.id)}>
              <td><input type="checkbox" readOnly checked={picked.has(d.id)} /></td>
              <td>{d.name}</td><td><code>{d.key}</code></td><td>{d.isSendable ? 'Yes' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <span>{picked.size} selected</span>
        <button disabled={!picked.size || busy} onClick={load}>{busy ? 'Reading schemas...' : 'Next: configure schema'}</button>
      </div>
    </section>
  );
}
