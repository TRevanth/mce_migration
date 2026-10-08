// MCE Data Extension field types -> Data Cloud Ingestion API (OpenAPI 3.0) types.
// The Ingestion API schema supports flat objects with string / number / boolean
// and string formats date / date-time only.
const TYPE_MAP = {
  text: { type: 'string' },
  emailaddress: { type: 'string' },
  phone: { type: 'string' },
  locale: { type: 'string' },
  number: { type: 'number' },
  decimal: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
};

export function mapFieldType(mceType) {
  return TYPE_MAP[String(mceType ?? '').toLowerCase()] ?? null;
}

// Data Cloud field/object API names: letters, digits and single underscores,
// must start with a letter, must not end with an underscore.
export function sanitizeName(raw, fallback = 'field') {
  let name = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (/^[0-9]/.test(name)) name = `f_${name}`;
  return name;
}
