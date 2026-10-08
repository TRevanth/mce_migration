import { ingestRecords } from './sf/client.js';

const BATCH = 200;
const PAGE = 1000;

const convert = (value, f) => {
  if (value === undefined || value === null || value === '') return null;
  if (f.type === 'number') { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (f.type === 'boolean') return /^(true|1|yes)$/i.test(String(value));
  if (f.format === 'date-time') { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  return String(value);
};

const lowerKeys = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Copy rows of one DE into its Ingestion API stream.
 * schema: a built schema ({ key, objectName, fields }); limit: max rows (omit for all).
 * Returns { object, status: 'loaded' | 'failed', sent, total, error? }.
 */
export async function loadSchema({ session, client, schema: s, connectorName, limit, ingest = ingestRecords }) {
  const max = Number(limit) > 0 ? Number(limit) : Infinity;
  let sent = 0, page = 1, total = null;
  try {
    while (sent < max) {
      const { rows, count } = await client.getRows(s.key, page, PAGE);
      total = count;
      if (!rows.length) break;
      const records = rows.slice(0, max - sent).map((raw, i) => {
        const row = lowerKeys(raw);
        return Object.fromEntries(s.fields.map((f) => [f.name, f.synthetic ? `${s.key}-${sent + i + 1}` : convert(row[String(f.source).toLowerCase()], f)]));
      });
      console.log(`[load] ${s.objectName}: sending ${records.length} records, sample:`, JSON.stringify(records.slice(0, 2), null, 2));
      for (let i = 0; i < records.length; i += BATCH) await ingest(session, connectorName, s.objectName, records.slice(i, i + BATCH));
      sent += records.length;
      if (rows.length < PAGE) break;
      page++;
    }
    return { object: s.objectName, status: 'loaded', sent, total };
  } catch (e) {
    console.error(`[load] ${s.objectName} failed after ${sent} rows:`, e.message);
    return { object: s.objectName, status: 'failed', sent, total, error: e.message };
  }
}
