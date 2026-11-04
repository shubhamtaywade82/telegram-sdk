export type TlSchemaSection = 'types' | 'functions';
export interface TlFieldDefinition { name: string; type: string }
export interface TlDefinition {
  name: string;
  id: number;
  fields: TlFieldDefinition[];
  resultType: string;
  section: TlSchemaSection;
  source: string;
}

const DEFINITION_PATTERN = /^([A-Za-z0-9_.]+)#([0-9a-fA-F]{8})\s*(.*?)\s*=\s*([A-Za-z0-9_.<>!]+)\s*;$/;

/**
 * Basic line-oriented parser for explicit-ID TL declarations.
 * It is not the complete Telegram TL grammar or a production code generator.
 */
export function parseTlSchema(source: string): TlDefinition[] {
  const definitions: TlDefinition[] = [];
  let section: TlSchemaSection = 'types';
  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    if (line === '---types---') { section = 'types'; continue; }
    if (line === '---functions---') { section = 'functions'; continue; }
    if (line.startsWith('---')) continue;
    const match = DEFINITION_PATTERN.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const idHex = match[2]!;
    const fieldsText = match[3]!;
    const resultType = match[4]!;
    const fields = fieldsText.trim()
      ? fieldsText.trim().split(/\s+/).flatMap((token): TlFieldDefinition[] => {
          const colon = token.indexOf(':');
          if (colon <= 0 || colon === token.length - 1) return [];
          return [{ name: token.slice(0, colon), type: token.slice(colon + 1) }];
        })
      : [];
    definitions.push({
      name, id: Number.parseInt(idHex, 16) >>> 0, fields, resultType, section, source: line,
    });
  }
  return definitions;
}
