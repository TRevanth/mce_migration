import { buildSchema } from '../mapper/schema.js';
import { toOpenApiYaml } from '../mapper/yaml.js';
import { createDataStream, findDataStream } from '../sf/client.js';
import { loadSchema } from '../load.js';

// Agent tools over the existing MCE / Data Cloud code. `write: true` tools never run without user approval.
// ctx: { session, getClient(), state } where state.schemas holds schemas built by build_schema (keyed by DE key).

const ANALYZE_ROWS = 2000;
const SAMPLE_MAX = 10;

const schemaOf = (ctx, key) => {
  const s = ctx.state.schemas[key];
  if (!s) throw new Error(`No built schema for "${key}". Call build_schema first.`);
  if (!s.valid) throw new Error(`Schema for "${key}" has errors and cannot be used: ${s.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ')}`);
  return s;
};

const requireSf = (ctx) => { if (!ctx.session.sf) throw new Error('Not connected to Salesforce. Ask the user to log in on the Connect step.'); };

export const TOOLS = {
  list_data_extensions: {
    description: 'List the Data Extensions in the connected Marketing Cloud account (id, customer key, name, sendable flag).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const des = await ctx.getClient().listDataExtensions();
      return des.map(({ id, key, name, isSendable }) => ({ id, key, name, isSendable }));
    },
  },

  get_de_fields: {
    description: 'Get the fields (name, type, length, primary key flag) and the row count of one Data Extension by its id (ObjectID from list_data_extensions).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    async run(ctx, { id }) {
      const client = ctx.getClient();
      const [fields, rowCount] = await Promise.all([client.getFields(id), client.getRowCount(id).catch(() => null)]);
      return { id, rowCount, fields };
    },
  },

  sample_rows: {
    description: `Fetch up to ${SAMPLE_MAX} real rows of a Data Extension (by customer key). The rows are sent to you, so only call it when seeing values helps.`,
    input_schema: { type: 'object', properties: { key: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: SAMPLE_MAX } }, required: ['key'], additionalProperties: false },
    async run(ctx, { key, n = 5 }) {
      const { rows, count } = await ctx.getClient().getRows(key, 1, Math.min(Number(n) || 5, SAMPLE_MAX));
      return { total: count, rows };
    },
  },

  analyze_keys: {
    description: `Profile the first ${ANALYZE_ROWS} rows of a Data Extension: per field, how many values are distinct and how many are blank. A primary key must be fully distinct and never blank, because Data Cloud keeps one record per primary key value (duplicates overwrite each other).`,
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    async run(ctx, { key }) {
      const client = ctx.getClient();
      const rows = [];
      let total = null;
      for (let page = 1; rows.length < ANALYZE_ROWS; page++) {
        const r = await client.getRows(key, page, 1000);
        total = r.count;
        rows.push(...r.rows);
        if (r.rows.length < 1000) break;
      }
      const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const fields = names.map((name) => {
        const vals = rows.map((r) => r[name]);
        const blank = vals.filter((v) => v === null || v === undefined || v === '').length;
        const distinct = new Set(vals.filter((v) => v !== null && v !== undefined && v !== '')).size;
        return { name, distinct, blank, uniqueKeyCandidate: blank === 0 && distinct === rows.length };
      });
      return { rowsAnalyzed: rows.length, totalRows: total, fields };
    },
  },

  build_schema: {
    description: 'Build and validate the Data Cloud schema for one or more Data Extensions, and remember it for create_data_stream and load_data. Returns each schema (object name, fields, primary key, issues) and the combined YAML for the Ingestion API connector. Fix any error issues (for example choose a primary key) and call again.',
    input_schema: {
      type: 'object',
      properties: {
        des: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Data Extension ObjectID' },
              key: { type: 'string', description: 'Data Extension customer key' },
              name: { type: 'string' },
              options: {
                type: 'object',
                properties: {
                  primaryKey: { type: 'string', description: 'Source field name' },
                  syntheticKey: { type: 'boolean' },
                  category: { type: 'string', enum: ['Profile', 'Engagement', 'Other'] },
                  eventTimeField: { type: 'string', description: 'Required when category is Engagement' },
                },
                additionalProperties: false,
              },
            },
            required: ['id', 'key', 'name'],
            additionalProperties: false,
          },
        },
      },
      required: ['des'],
      additionalProperties: false,
    },
    async run(ctx, { des }) {
      const client = ctx.getClient();
      const schemas = [];
      for (const d of des) {
        const fields = await client.getFields(d.id);
        const built = { key: d.key, ...buildSchema({ key: d.key, name: d.name, fields }, d.options ?? {}) };
        ctx.state.schemas[d.key] = built;
        schemas.push(built);
      }
      const valid = schemas.filter((s) => s.valid);
      return {
        schemas: schemas.map((s) => ({ key: s.key, objectName: s.objectName, valid: s.valid, primaryKey: s.primaryKey, category: s.category, fields: s.fields.map((f) => `${f.source ?? '(synthetic)'} -> ${f.name} (${f.type}${f.format ? `/${f.format}` : ''})`), issues: s.issues })),
        yaml: valid.length ? toOpenApiYaml(valid) : null,
      };
    },
  },

  verify_stream: {
    description: 'List the Salesforce data streams whose name starts with the given text, to check a data stream exists. Matches by name prefix only.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    async run(ctx, { name }) {
      requireSf(ctx);
      const r = await findDataStream(ctx.session, name);
      const list = r.body?.dataStreams ?? [];
      const matches = list.filter((d) => (d.name ?? '').toLowerCase().startsWith(String(name).toLowerCase())).map((d) => ({ name: d.name, label: d.label }));
      return { ok: r.ok, found: matches.length > 0, matches, error: r.ok ? undefined : r.body };
    },
  },

  create_data_stream: {
    write: true,
    description: 'Create Ingestion API data streams in Data Cloud for DEs that already have a valid schema from build_schema. The user must approve. If Salesforce rejects the request, the result says so and carries manual steps to relay.',
    input_schema: { type: 'object', properties: { connectorName: { type: 'string' }, keys: { type: 'array', items: { type: 'string' }, description: 'DE customer keys' } }, required: ['connectorName', 'keys'], additionalProperties: false },
    summarize: ({ connectorName, keys }) => `Create ${keys.length} data stream(s) on connector "${connectorName}" for: ${keys.join(', ')}`,
    async run(ctx, { connectorName, keys }) {
      requireSf(ctx);
      const results = [];
      for (const key of keys) {
        const s = schemaOf(ctx, key);
        const r = await createDataStream(ctx.session, { connectorName, ...s });
        results.push(r.ok
          ? { object: s.objectName, status: 'created' }
          : { object: s.objectName, status: 'manual', httpStatus: r.status, detail: r.body, steps: [
            `Data Cloud > Data Streams > New > Ingestion API > select connector "${connectorName}".`,
            `Choose object "${s.objectName}" (upload the YAML to the connector first if it is missing).`,
            `Set category "${s.category}", primary key "${s.primaryKey}"${s.eventTimeField ? `, event time "${s.eventTimeField}"` : ''}.`,
          ] });
      }
      return { results };
    },
  },

  load_data: {
    write: true,
    description: 'Copy rows from Data Extensions into their already deployed Ingestion API data streams. Needs a valid schema from build_schema. Use a small `limit` for a test load first. The user must approve. Data Cloud processes streaming data asynchronously (roughly every 15 minutes), so rows can take a while to appear.',
    input_schema: { type: 'object', properties: { connectorName: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, description: 'Max rows per DE; omit for all rows' } }, required: ['connectorName', 'keys'], additionalProperties: false },
    summarize: ({ connectorName, keys, limit }) => `Load ${limit ? `up to ${limit} rows` : 'ALL rows'} of ${keys.join(', ')} into connector "${connectorName}"`,
    async run(ctx, { connectorName, keys, limit }) {
      requireSf(ctx);
      const client = ctx.getClient();
      const results = [];
      for (const key of keys) results.push(await loadSchema({ session: ctx.session, client, schema: schemaOf(ctx, key), connectorName, limit }));
      return { results };
    },
  },
};

// Tool definitions in the Messages API shape.
export const toolDefinitions = () => Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
