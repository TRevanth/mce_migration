import { describe, it, expect, vi } from 'vitest';
import { chat, decide, newAgentState } from './loop.js';
import { TOOLS } from './tools.js';

// A stub Messages client that replays scripted responses and records each request.
const scripted = (...responses) => {
  const calls = [];
  return { calls, messages: { create: vi.fn(async (req) => { calls.push(structuredClone(req.messages)); return responses.shift(); }) } };
};
const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

const mceClient = {
  listDataExtensions: async () => [{ id: 'oid1', key: 'k1', name: 'Subs', isSendable: false }],
  getRows: async () => ({ count: 4, rows: [{ Id: '1', City: 'A' }, { Id: '2', City: 'A' }, { Id: '3', City: 'A' }, { Id: '4', City: 'B' }] }),
};
const base = (extra = {}) => ({ state: newAgentState(), session: { sf: { accessToken: 'sekret' } }, getClient: () => mceClient, ...extra });

describe('agent loop', () => {
  it('runs read tools without approval and returns the final reply', async () => {
    const llm = scripted(toolUse('t1', 'list_data_extensions', {}), text('You have one DE.'));
    const r = await chat({ ...base(), message: 'what DEs do I have?', llm });
    expect(r.reply).toBe('You have one DE.');
    expect(r.pending).toBeNull();
    expect(r.toolLog).toEqual([{ name: 'list_data_extensions', input: {}, ok: true }]);
    // The tool result went back as a single user message.
    const last = llm.calls[1].at(-1);
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  });

  it('pauses on a write tool and does not run it until approved', async () => {
    const run = vi.spyOn(TOOLS.load_data, 'run').mockResolvedValue({ results: [{ status: 'loaded', sent: 5 }] });
    const llm = scripted(toolUse('w1', 'load_data', { connectorName: 'c', keys: ['k1'], limit: 5 }), text('Loaded.'));
    const ctx = base();
    const r = await chat({ ...ctx, message: 'load it', llm });
    expect(r.pending).toMatchObject({ id: 'w1', tool: 'load_data' });
    expect(run).not.toHaveBeenCalled();
    // A new chat message is refused while an action is pending.
    await expect(chat({ ...ctx, message: 'hello', llm })).rejects.toMatchObject({ status: 409 });

    const done = await decide({ ...ctx, id: 'w1', approve: true, llm });
    expect(run).toHaveBeenCalledOnce();
    expect(done.pending).toBeNull();
    expect(done.reply).toBe('Loaded.');
    run.mockRestore();
  });

  it('tells the model when the user rejects a write', async () => {
    const run = vi.spyOn(TOOLS.create_data_stream, 'run');
    const llm = scripted(toolUse('w1', 'create_data_stream', { connectorName: 'c', keys: ['k1'] }), text('Okay, skipping.'));
    const ctx = base();
    await chat({ ...ctx, message: 'create it', llm });
    await decide({ ...ctx, id: 'w1', approve: false, llm });
    expect(run).not.toHaveBeenCalled();
    expect(llm.calls[1].at(-1).content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    run.mockRestore();
  });

  it('keeps all tool results of a parallel turn in one user message, pausing at the write', async () => {
    const llm = scripted(
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'a', name: 'list_data_extensions', input: {} },
        { type: 'tool_use', id: 'b', name: 'load_data', input: { connectorName: 'c', keys: ['k1'] } },
      ] },
      text('done'),
    );
    vi.spyOn(TOOLS.load_data, 'run').mockResolvedValue({ ok: true });
    const ctx = base();
    const r = await chat({ ...ctx, message: 'go', llm });
    expect(r.pending.id).toBe('b');
    await decide({ ...ctx, id: 'b', approve: true, llm });
    const results = llm.calls[1].at(-1).content;
    expect(results.map((x) => x.tool_use_id)).toEqual(['a', 'b']);
    TOOLS.load_data.run.mockRestore();
  });

  it('turns tool errors into is_error results instead of throwing', async () => {
    const llm = scripted(toolUse('t1', 'analyze_keys', { key: 'k1' }), text('ok'));
    const ctx = base({ getClient: () => ({ getRows: async () => { throw new Error('MCE 404'); } }) });
    const r = await chat({ ...ctx, message: 'x', llm });
    expect(r.toolLog[0]).toMatchObject({ ok: false, error: 'MCE 404' });
    expect(llm.calls[1].at(-1).content[0]).toMatchObject({ is_error: true, content: 'MCE 404' });
  });

  it('redacts secret-looking keys from tool results', async () => {
    vi.spyOn(TOOLS.verify_stream, 'run').mockResolvedValue({ found: true, accessToken: 'abc123', nested: { client_secret: 'zzz' } });
    const llm = scripted(toolUse('t1', 'verify_stream', { name: 'x' }), text('ok'));
    await chat({ ...base(), message: 'x', llm });
    const sent = llm.calls[1].at(-1).content[0].content;
    expect(sent).not.toContain('abc123');
    expect(sent).not.toContain('zzz');
    TOOLS.verify_stream.run.mockRestore();
  });
});

describe('analyze_keys', () => {
  it('flags unique candidates and duplicate fields', async () => {
    const out = await TOOLS.analyze_keys.run({ getClient: () => mceClient }, { key: 'k1' });
    const by = Object.fromEntries(out.fields.map((f) => [f.name, f]));
    expect(by.Id).toMatchObject({ distinct: 4, uniqueKeyCandidate: true });
    expect(by.City).toMatchObject({ distinct: 2, uniqueKeyCandidate: false });
  });
});
