import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const CATEGORIES = ['Profile', 'Engagement', 'Other'];
const DEFAULTS = { primaryKey: '', syntheticKey: false, category: 'Other', eventTimeField: '' };

export default function Configure({ selected, onBuilt, next }) {
  const [opts, setOpts] = useState({}); // key -> options
  const [result, setResult] = useState({ schemas: [], yaml: '' });
  const [error, setError] = useState('');
  const optsFor = (key) => ({ ...DEFAULTS, ...opts[key] });
  const patch = (key, p) => setOpts((o) => ({ ...o, [key]: { ...optsFor(key), ...p } }));

  // Re-validate on the server (single source of truth for the rules) whenever choices change.
  const payload = useMemo(() => selected.map((d) => ({
    key: d.key, name: d.name, fields: d.fields,
    options: { ...optsFor(d.key), primaryKey: optsFor(d.key).primaryKey || undefined, eventTimeField: optsFor(d.key).eventTimeField || undefined },
  })), [selected, opts]);

  useEffect(() => {
    api.buildSchema(payload).then((r) => { setResult(r); onBuilt(r); setError(''); }).catch((e) => setError(e.message));
  }, [payload]);

  const byKey = Object.fromEntries(result.schemas.map((s) => [s.key, s]));

  return (
    <div>
      {error && <p className="error">{error}</p>}
      {selected.map((d) => {
        const o = optsFor(d.key);
        const s = byKey[d.key];
        const dateFields = d.fields.filter((f) => f.type?.toLowerCase() === 'date');
        return (
          <section className="card" key={d.key}>
            <h2>{d.name} <small>{d.fields.length} fields{d.rowCount != null ? `, ${d.rowCount} rows` : ''}</small> {s && <span className={s.valid ? 'ok' : 'bad'}>{s.valid ? 'Ready' : 'Needs attention'}</span>}</h2>
            <div className="grid3">
              <label>Primary key
                <select value={o.syntheticKey ? '__synthetic' : o.primaryKey} onChange={(e) => e.target.value === '__synthetic' ? patch(d.key, { syntheticKey: true, primaryKey: '' }) : patch(d.key, { syntheticKey: false, primaryKey: e.target.value })}>
                  <option value="">Use existing MCE key</option>
                  {d.fields.map((f) => <option key={f.name} value={f.name}>{f.name}{f.isPrimaryKey ? ' (MCE key)' : ''}</option>)}
                  <option value="__synthetic">Add synthetic key (record_id)</option>
                </select>
              </label>
              <label>Category
                <select value={o.category} onChange={(e) => patch(d.key, { category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              {o.category === 'Engagement' && (
                <label>Event time field
                  <select value={o.eventTimeField} onChange={(e) => patch(d.key, { eventTimeField: e.target.value })}>
                    <option value="">Choose a date field</option>
                    {dateFields.map((f) => <option key={f.name}>{f.name}</option>)}
                  </select>
                </label>
              )}
            </div>

            <table>
              <thead><tr><th>MCE field</th><th>MCE type</th><th>Data Cloud field</th><th>Data Cloud type</th></tr></thead>
              <tbody>
                {s?.fields.map((f) => (
                  <tr key={f.name} className={f.name === s.primaryKey ? 'pk' : ''}>
                    <td>{f.source ?? <em>(new)</em>}</td>
                    <td>{d.fields.find((x) => x.name === f.source)?.type ?? ''}</td>
                    <td><code>{f.name}</code>{f.name === s.primaryKey && ' (PK)'}</td>
                    <td>{f.type}{f.format ? ` / ${f.format}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {s?.issues.length > 0 && (
              <ul className="issues">
                {s.issues.map((i, n) => <li key={n} className={i.level}>{i.level === 'error' ? 'Error: ' : 'Note: '}{i.message}</li>)}
              </ul>
            )}
          </section>
        );
      })}
      <div className="actions">
        <span>{result.schemas.filter((s) => s.valid).length} of {result.schemas.length} ready</span>
        <button disabled={!result.schemas.some((s) => s.valid)} onClick={next}>Next: create data streams</button>
      </div>
    </div>
  );
}
