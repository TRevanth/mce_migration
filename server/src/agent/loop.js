import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, toolDefinitions } from './tools.js';
import { SYSTEM_PROMPT } from './prompt.js';

const MODEL = () => process.env.AGENT_MODEL || 'claude-opus-5-5';
const MAX_STEPS = 25;

export const newAgentState = () => ({ messages: [], schemas: {}, turn: null });

// Keep credentials out of anything the model reads, whatever a tool returns.
const SECRET_KEY = /token|secret|authorization|password/i;
const redact = (_k, v) => (SECRET_KEY.test(_k) ? '[redacted]' : v);
const toContent = (value) => JSON.stringify(value, redact);

const pendingOf = (use) => ({ id: use.id, tool: use.name, input: use.input, summary: TOOLS[use.name].summarize?.(use.input) ?? use.name });

// Runs the tool calls of the current assistant turn. Stops at the first write tool that has no decision yet.
async function processTurn(ctx, log) {
  const { turn } = ctx.state;
  for (const use of turn.uses) {
    if (use.id in turn.results) continue;
    const tool = TOOLS[use.name];
    if (!tool) { turn.results[use.id] = { content: `Unknown tool "${use.name}".`, is_error: true }; continue; }
    if (tool.write) {
      const decision = turn.approvals[use.id];
      if (decision === undefined) return pendingOf(use);
      if (decision === false) {
        turn.results[use.id] = { content: 'The user rejected this action. Do not retry it; ask what they want instead.', is_error: true };
        log.push({ name: use.name, input: use.input, ok: false, rejected: true });
        continue;
      }
    }
    try {
      const out = await tool.run(ctx, use.input ?? {});
      turn.results[use.id] = { content: toContent(out) };
      log.push({ name: use.name, input: use.input, ok: true });
    } catch (e) {
      console.error(`[agent] tool ${use.name} failed:`, e.message);
      turn.results[use.id] = { content: e.message, is_error: true };
      log.push({ name: use.name, input: use.input, ok: false, error: e.message });
    }
  }
  return null;
}

async function run(ctx, llm, log, texts) {
  const { state } = ctx;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (state.turn) {
      const pending = await processTurn(ctx, log);
      if (pending) return { reply: texts.join('\n\n'), toolLog: log, pending };
      // All tool results go back in one user message, in call order.
      state.messages.push({
        role: 'user',
        content: state.turn.uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, ...state.turn.results[u.id] })),
      });
      state.turn = null;
    }

    const resp = await llm.messages.create({
      model: MODEL(), max_tokens: 16000, system: SYSTEM_PROMPT, tools: toolDefinitions(), messages: state.messages,
    });
    // Append the content unchanged: thinking blocks must be passed back as they came.
    state.messages.push({ role: 'assistant', content: resp.content });
    for (const b of resp.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());

    if (resp.stop_reason === 'refusal') { texts.push('The model declined this request.'); return { reply: texts.join('\n\n'), toolLog: log, pending: null }; }
    if (resp.stop_reason === 'max_tokens') texts.push('(The reply was cut off. Ask me to continue.)');
    if (resp.stop_reason !== 'tool_use') return { reply: texts.join('\n\n'), toolLog: log, pending: null };

    const uses = resp.content.filter((b) => b.type === 'tool_use');
    state.turn = { uses, results: {}, approvals: {} };
  }
  texts.push(`Stopped after ${MAX_STEPS} steps. Tell me how to continue.`);
  return { reply: texts.join('\n\n'), toolLog: log, pending: null };
}

const defaultLlm = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  return new Anthropic();
};

const hasPending = (state) => !!state.turn && state.turn.uses.some((u) => !(u.id in state.turn.results));

export async function chat({ state, session, getClient, message, llm = defaultLlm() }) {
  if (hasPending(state)) throw Object.assign(new Error('Approve or reject the pending action first.'), { status: 409 });
  state.messages.push({ role: 'user', content: message });
  return run({ state, session, getClient }, llm, [], []);
}

export async function decide({ state, session, getClient, id, approve, llm = defaultLlm() }) {
  const use = state.turn?.uses.find((u) => u.id === id);
  if (!use || id in state.turn.results) throw Object.assign(new Error('No such pending action.'), { status: 404 });
  state.turn.approvals[id] = !!approve;
  return run({ state, session, getClient }, llm, [], []);
}
