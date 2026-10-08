import { mapFieldType, sanitizeName } from './typeMap.js';

export const CATEGORIES = ['Profile', 'Engagement', 'Other'];
export const SYNTHETIC_KEY = 'record_id';

/**
 * Build a Data Cloud-ready schema model from an MCE DE and the user's choices.
 *
 * de:      { key, name, fields: [{ name, type, isPrimaryKey, length, ... }] }
 * options: { primaryKey?: string (MCE field name), category?: string,
 *            eventTimeField?: string (MCE field name), objectName?: string }
 *
 * Returns { objectName, fields, primaryKey, category, eventTimeField, issues, valid }.
 * Each issue is { level: 'error' | 'warn', code, message, field? }.
 */
export function buildSchema(de, options = {}) {
  const issues = [];
  const used = new Set();
  const nameFor = (raw, fallback) => {
    let base = sanitizeName(raw, fallback);
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${i++}`;
    used.add(name.toLowerCase());
    return name;
  };

  const objectName = sanitizeName(options.objectName || de.name || de.key, 'data_extension');
  if (objectName !== de.name) {
    issues.push({ level: 'warn', code: 'OBJECT_RENAMED', message: `Object name "${de.name}" becomes "${objectName}".` });
  }

  const fields = [];
  for (const f of de.fields ?? []) {
    const mapped = mapFieldType(f.type);
    if (!mapped) {
      issues.push({ level: 'error', code: 'UNSUPPORTED_TYPE', field: f.name, message: `Field "${f.name}" has unsupported type "${f.type}".` });
      continue;
    }
    const name = nameFor(f.name, 'field');
    if (name !== f.name) {
      issues.push({ level: 'warn', code: 'FIELD_RENAMED', field: f.name, message: `Field "${f.name}" becomes "${name}".` });
    }
    fields.push({ source: f.name, name, ...mapped, isPrimaryKeyInSource: !!f.isPrimaryKey });
  }

  // Primary key: explicit choice > existing MCE PK > synthetic.
  const bySource = new Map(fields.map((f) => [f.source, f]));
  let primaryKey = null;
  if (options.primaryKey) {
    const pk = bySource.get(options.primaryKey);
    if (pk) primaryKey = pk.name;
    else issues.push({ level: 'error', code: 'PK_NOT_FOUND', message: `Chosen primary key "${options.primaryKey}" is not a field of this DE.` });
  } else {
    const sourcePks = fields.filter((f) => f.isPrimaryKeyInSource);
    if (sourcePks.length === 1) primaryKey = sourcePks[0].name;
    else if (sourcePks.length > 1) {
      issues.push({ level: 'error', code: 'COMPOSITE_PK', message: `DE has a composite primary key (${sourcePks.map((f) => f.source).join(', ')}). Pick one field or add a synthetic key.` });
    }
  }
  if (!primaryKey && !issues.some((i) => i.code === 'PK_NOT_FOUND' || i.code === 'COMPOSITE_PK')) {
    issues.push({ level: 'warn', code: 'NO_PK', message: 'DE has no primary key. Pick one, or add a synthetic key.' });
  }
  if (options.syntheticKey) {
    const name = nameFor(SYNTHETIC_KEY, SYNTHETIC_KEY);
    fields.unshift({ source: null, name, type: 'string', synthetic: true });
    primaryKey = name;
    issues.splice(0, issues.length, ...issues.filter((i) => !['NO_PK', 'COMPOSITE_PK', 'PK_NOT_FOUND'].includes(i.code)));
    issues.push({ level: 'warn', code: 'SYNTHETIC_KEY', message: `Synthetic key "${name}" added. The source system must populate it when loading data.` });
  }
  if (!primaryKey) {
    issues.push({ level: 'error', code: 'PK_REQUIRED', message: 'A primary key is required to create the data stream.' });
  }

  // Category and event time.
  const category = options.category ?? 'Other';
  if (!CATEGORIES.includes(category)) {
    issues.push({ level: 'error', code: 'BAD_CATEGORY', message: `Category must be one of ${CATEGORIES.join(', ')}.` });
  }
  let eventTimeField = null;
  if (category === 'Engagement') {
    const et = options.eventTimeField ? bySource.get(options.eventTimeField) : null;
    if (et && et.format === 'date-time') eventTimeField = et.name;
    else issues.push({ level: 'error', code: 'EVENT_TIME_REQUIRED', message: 'Engagement data needs a date field as the event time.' });
  }

  const valid = !issues.some((i) => i.level === 'error');
  return { objectName, fields, primaryKey, category, eventTimeField, issues, valid };
}
