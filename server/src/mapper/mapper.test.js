import { describe, expect, it } from 'vitest';
import { mapFieldType, sanitizeName } from './typeMap.js';
import { buildSchema } from './schema.js';
import { toOpenApiYaml } from './yaml.js';

describe('mapFieldType', () => {
  it('maps MCE types', () => {
    expect(mapFieldType('Text')).toEqual({ type: 'string' });
    expect(mapFieldType('EmailAddress')).toEqual({ type: 'string' });
    expect(mapFieldType('Decimal')).toEqual({ type: 'number' });
    expect(mapFieldType('Date')).toEqual({ type: 'string', format: 'date-time' });
    expect(mapFieldType('Boolean')).toEqual({ type: 'boolean' });
  });
  it('returns null for unknown types', () => {
    expect(mapFieldType('Blob')).toBeNull();
  });
});

describe('sanitizeName', () => {
  it('cleans spaces, symbols and leading digits', () => {
    expect(sanitizeName('First Name')).toBe('First_Name');
    expect(sanitizeName('  e-mail!! ')).toBe('e_mail');
    expect(sanitizeName('1st_Order')).toBe('f_1st_Order');
    expect(sanitizeName('__x__y__')).toBe('x_y');
    expect(sanitizeName('???')).toBe('field');
  });
});

const de = (fields, name = 'Customers') => ({ key: 'k', name, fields });

describe('buildSchema', () => {
  it('uses the single MCE primary key', () => {
    const s = buildSchema(de([{ name: 'Id', type: 'Text', isPrimaryKey: true }, { name: 'Email', type: 'EmailAddress' }]));
    expect(s.valid).toBe(true);
    expect(s.primaryKey).toBe('Id');
  });

  it('errors when there is no primary key, and a synthetic key fixes it', () => {
    const d = de([{ name: 'Email', type: 'EmailAddress' }]);
    expect(buildSchema(d).valid).toBe(false);
    const fixed = buildSchema(d, { syntheticKey: true });
    expect(fixed.valid).toBe(true);
    expect(fixed.primaryKey).toBe('record_id');
    expect(fixed.fields[0].synthetic).toBe(true);
  });

  it('flags composite keys and lets the user pick one', () => {
    const d = de([
      { name: 'A', type: 'Text', isPrimaryKey: true },
      { name: 'B', type: 'Text', isPrimaryKey: true },
    ]);
    expect(buildSchema(d).issues.some((i) => i.code === 'COMPOSITE_PK')).toBe(true);
    expect(buildSchema(d, { primaryKey: 'A' }).primaryKey).toBe('A');
  });

  it('renames fields, dedupes collisions and reports them', () => {
    const s = buildSchema(de([{ name: 'First Name', type: 'Text', isPrimaryKey: true }, { name: 'First-Name', type: 'Text' }]));
    expect(s.fields.map((f) => f.name)).toEqual(['First_Name', 'First_Name_2']);
    expect(s.issues.filter((i) => i.code === 'FIELD_RENAMED')).toHaveLength(2);
  });

  it('errors on unsupported types', () => {
    const s = buildSchema(de([{ name: 'Id', type: 'Text', isPrimaryKey: true }, { name: 'X', type: 'Blob' }]));
    expect(s.valid).toBe(false);
  });

  it('requires a date event-time field for Engagement', () => {
    const d = de([{ name: 'Id', type: 'Text', isPrimaryKey: true }, { name: 'SentAt', type: 'Date' }]);
    expect(buildSchema(d, { category: 'Engagement' }).valid).toBe(false);
    const ok = buildSchema(d, { category: 'Engagement', eventTimeField: 'SentAt' });
    expect(ok.valid).toBe(true);
    expect(ok.eventTimeField).toBe('SentAt');
  });
});

describe('toOpenApiYaml', () => {
  it('emits an OpenAPI document', () => {
    const s = buildSchema(de([{ name: 'Id', type: 'Text', isPrimaryKey: true }, { name: 'Created', type: 'Date' }]));
    const yaml = toOpenApiYaml([s]);
    expect(yaml).toContain('openapi: 3.0.3');
    expect(yaml).toContain('    Customers:');
    expect(yaml).toContain('          format: date-time');
  });
});
