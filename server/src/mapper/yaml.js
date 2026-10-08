// Emit the OpenAPI 3.0 schema Data Cloud's Ingestion API connector expects.
// Names are sanitized upstream so no YAML quoting is needed.
export function toOpenApiYaml(schemas) {
  const lines = ['openapi: 3.0.3', 'info:', '  title: MCE Data Extension migration', '  version: 1.0.0', 'components:', '  schemas:'];
  for (const s of schemas) {
    lines.push(`    ${s.objectName}:`, '      type: object', '      properties:');
    for (const f of s.fields) {
      lines.push(`        ${f.name}:`, `          type: ${f.type}`);
      if (f.format) lines.push(`          format: ${f.format}`);
    }
  }
  return lines.join('\n') + '\n';
}
