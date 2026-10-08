import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const RUN = 'Migrate my Data Extensions to Data Cloud. Start by listing them and proposing a plan.';

// Chat panel for the migration agent. Write actions arrive as `pending` and need an explicit click.
export default function Agent({ enabled }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]); // { role: 'user' | 'agent' | 'tools', text }
  const [pending, setPending] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [items, pending, busy]);

  function apply(r) {
    setItems((prev) => [
      ...prev,
      ...(r.toolLog?.length ? [{ role: 'tools', text: r.toolLog.map((t) => `${t.name}${t.rejected ? ' (rejected)' : t.ok ? '' : ' (failed)'}`).join(', ') }] : []),
      ...(r.reply ? [{ role: 'agent', text: r.reply }] : []),
    ]);
    setPending(r.pending ?? null);
  }

  async function call(fn) {
    setBusy(true);
    try { apply(await fn()); }
    catch (e) { setItems((prev) => [...prev, { role: 'error', text: e.message }]); }
    finally { setBusy(false); }
  }

  function send(text) {
    if (!text.trim() || busy || pending) return;
    setItems((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    call(() => api.agentChat(text));
  }

  async function reset() {
    await api.agentReset().catch(() => {});
    setItems([]); setPending(null);
  }

  if (!open) return <button className="agent-fab" onClick={() => setOpen(true)}>Ask the agent</button>;

  return (
    <aside className="agent">
      <header>
        <strong>Migration agent</strong>
        <span>
          <button onClick={reset} disabled={busy}>New chat</button>
          <button onClick={() => setOpen(false)}>Close</button>
        </span>
      </header>

      {!enabled && <p className="error">Set ANTHROPIC_API_KEY in server/.env and restart the server to use the agent.</p>}

      <div className="agent-log">
        {!items.length && (
          <div className="hint">
            <p>I can inspect your Data Extensions, pick keys, build the schema, create streams and load data. Nothing is created or loaded until you approve it. Sampled rows are sent to the model.</p>
            <button disabled={!enabled || busy} onClick={() => send(RUN)}>Run migration</button>
          </div>
        )}
        {items.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}
        {pending && (
          <div className="approve">
            <strong>Approve this action?</strong>
            <p>{pending.summary}</p>
            <button disabled={busy} onClick={() => call(() => api.agentApprove(pending.id, true))}>Approve</button>{' '}
            <button disabled={busy} onClick={() => call(() => api.agentApprove(pending.id, false))}>Reject</button>
          </div>
        )}
        {busy && <div className="msg tools">Working...</div>}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={pending ? 'Approve or reject first' : 'Ask, e.g. why do I see fewer rows?'} disabled={!enabled || busy || !!pending} />
        <button disabled={!enabled || busy || !!pending || !input.trim()}>Send</button>
      </form>
    </aside>
  );
}
