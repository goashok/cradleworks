// `factory config explain [<key>]`: what a factory.yaml key means, from three sources that each
// stay true on their own: the schema (type, allowed values, range: what loading enforces),
// defaults/factory.yaml (the default), and docs/reference/configuration.md (the meaning). Nothing
// is written here twice, so nothing here goes stale; a test checks the reference and the schema
// cover the same keys.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS_PATH, FACTORY_YAML, PROJECT_CONFIG_PATH, parseYaml, type Field } from '@cradleworks/config';
import { docsDir } from './docs.ts';

export interface KeyInfo {
  /** Dotted, with `<name>` for a key of your choosing. */
  key: string;
  type: string;
  required: boolean;
}

export interface DocEntry {
  /** Dotted, with `<role>`, `<name>` and so on for keys of your choosing. */
  key: string;
  meaning: string;
  status: string;
  /** configuration.md and the section's anchor. */
  section: string;
}

function describe(f: Field): string {
  switch (f.kind) {
    case 'enum':
      return `one of ${f.values.join(', ')}`;
    case 'number': {
      const range = [
        f.min !== undefined ? `${f.exclusiveMin ? '>' : '≥'} ${f.min}` : '',
        f.max !== undefined ? `≤ ${f.max}` : '',
      ].filter(Boolean);
      return `${f.integer ? 'whole number' : 'number'}${range.length ? ` ${range.join(' and ')}` : ''}`;
    }
    case 'stringList':
      return 'a string or a list of strings';
    case 'object':
      return 'a mapping';
    default:
      return f.kind;
  }
}

/** Every key the schema knows, leaves and mappings, in schema order. */
export function schemaKeys(field: Field = FACTORY_YAML, prefix = ''): KeyInfo[] {
  if (field.kind !== 'object') return [];
  const out: KeyInfo[] = [];
  const add = (name: string, f: Field) => {
    const key = prefix ? `${prefix}.${name}` : name;
    out.push({ key, type: describe(f), required: !!f.required });
    out.push(...schemaKeys(f, key));
  };
  for (const [name, f] of Object.entries(field.fields)) add(name, f);
  if (field.extra) add('<name>', field.extra);
  return out;
}

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The key tables in configuration.md, as dotted keys. */
export function docEntries(text = readFileSync(join(docsDir(), 'reference', 'configuration.md'), 'utf8')): DocEntry[] {
  const out: DocEntry[] = [];
  let prefix: string | undefined;
  let section = '';
  let header: string[] | undefined;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      const title = h[1]!;
      section = `reference/configuration.md#${slug(title)}`;
      const key = /^`([^`]+)`/.exec(title)?.[1];
      prefix = key ?? (/^other keys$/i.test(title) ? '' : undefined);
      header = undefined;
      continue;
    }
    if (prefix === undefined || !line.startsWith('|')) {
      if (!line.startsWith('|')) header = undefined;
      continue;
    }
    const row = cells(line);
    if (!header) {
      header = row.map((c) => c.toLowerCase());
      continue;
    }
    if (row.every((c) => /^-+$/.test(c))) continue;
    const first = row[0] ?? '';
    const names: string[] = [];
    if (/^any other key$/i.test(first)) names.push('<name>');
    else {
      let last = '';
      for (const m of first.matchAll(/`([^`]+)`/g)) {
        const n = m[1]!;
        // "`roles.<role>.skills` / `.always_skills`": a sibling of the one before.
        const full = n.startsWith('.') && last ? `${last.slice(0, last.lastIndexOf('.'))}${n}` : n;
        names.push(full);
        last = full;
      }
    }
    const status = row[header.indexOf('status')] ?? '';
    for (const n of names) out.push({ key: prefix && n !== prefix ? `${prefix}.${n}` : n, meaning: row.at(-1) ?? '', status, section });
  }
  return out;
}

const placeholder = (seg: string | undefined) => !!seg && /^<[^>]+>$/.test(seg);

/** Whether a documented key (`<role>`, `<name>`: any name) covers `key`, which may hold placeholders too. */
export function docMatches(docKey: string, key: string): boolean {
  const a = docKey.split('.');
  const b = key.split('.');
  return a.length === b.length && a.every((seg, i) => seg === b[i] || placeholder(seg));
}

/** Documented rows under a mapping key, such as `gates` or `runtime.roles.reviewer`. */
export function docsUnder(docs: DocEntry[], key: string): DocEntry[] {
  const k = key.split('.');
  return docs.filter((d) => {
    const s = d.key.split('.');
    return s.length > k.length && k.every((seg, i) => seg === s[i] || placeholder(s[i]) || placeholder(seg));
  });
}

/** The row for `key`: its own, else a placeholder row, else its nearest documented parent's. */
export function docFor(docs: DocEntry[], key: string): DocEntry | undefined {
  for (let parts = key.split('.'); parts.length; parts = parts.slice(0, -1)) {
    const k = parts.join('.');
    const hit = docs.find((d) => d.key === k) ?? docs.find((d) => docMatches(d.key, k));
    if (hit) return hit;
  }
  return undefined;
}

function valueAt(obj: unknown, key: string): unknown {
  let at: unknown = obj;
  for (const seg of key.split('.')) {
    if (!at || typeof at !== 'object' || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[seg];
  }
  return at;
}

const show = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

export interface Explained {
  key: string;
  type: string;
  required: boolean;
  default?: string;
  /** In the project's factory.yaml, when run inside one. */
  current?: string;
  meaning?: string;
  status?: string;
  docs?: string;
  /** Keys one level down. */
  children: string[];
}

/** `key` as written (`verify.agent_checks.security.blocks`) or with placeholders. */
export function explain(key: string, repoRoot?: string): Explained | { unknown: string; suggestions: string[] } {
  const keys = schemaKeys();
  const asked = key.split('.');
  const info = keys.find((k) => {
    const segs = k.key.split('.');
    return segs.length === asked.length && segs.every((s, i) => s === '<name>' || s === asked[i]);
  });
  if (!info) {
    const last = key.split('.').at(-1)!;
    const suggestions = keys
      .map((k) => k.key)
      .filter((k) => k.endsWith(`.${last}`) || k === last || k.includes(last) || key.includes(k.split('.').at(-1)!))
      .slice(0, 6);
    return { unknown: key, suggestions };
  }
  const docs = docEntries();
  // A mapping is documented by the rows under it; a leaf by its own row, or its parent's.
  const under = info.type === 'a mapping' ? docsUnder(docs, key) : [];
  const doc = under.length ? undefined : docFor(docs, key);
  const defaults = parseYaml(readFileSync(DEFAULTS_PATH, 'utf8'), 'defaults/factory.yaml');
  const def = show(valueAt(defaults, key));
  let current: string | undefined;
  if (repoRoot && existsSync(join(repoRoot, PROJECT_CONFIG_PATH))) current = show(valueAt(parseYaml(readFileSync(join(repoRoot, PROJECT_CONFIG_PATH), 'utf8'), PROJECT_CONFIG_PATH), key));
  const depth = info.key.split('.').length;
  const children = keys.filter((k) => k.key.startsWith(`${info.key}.`) && k.key.split('.').length === depth + 1).map((k) => k.key.split('.').at(-1)!);
  return {
    key,
    type: info.type,
    required: info.required,
    ...(def !== undefined ? { default: def } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(doc ? { meaning: doc.meaning, status: doc.status, docs: `docs/${doc.section}` } : under[0] ? { docs: `docs/${under[0].section}` } : {}),
    children,
  };
}

export function formatExplained(e: Explained): string {
  const lines = [`${e.key}: ${e.type}${e.required ? ', required' : ''}`];
  if (e.default !== undefined) lines.push(`  default   ${e.default}`);
  if (e.current !== undefined) lines.push(`  this repo ${e.current}`);
  else if (e.default !== undefined) lines.push('  this repo not set, so the default applies');
  if (e.status) lines.push(`  status    ${e.status}`);
  if (e.children.length) lines.push(`  keys      ${e.children.join(', ')}`);
  if (e.meaning) lines.push('', `  ${e.meaning}`);
  if (e.docs) lines.push('', `  More: factory docs configuration, or ${e.docs}`);
  return `${lines.join('\n')}\n`;
}

/** Every key, one line each, for `factory config explain` with no key. */
export function formatKeyList(): string {
  return `${schemaKeys()
    .map((k) => `  ${k.key.padEnd(42)} ${k.type}`)
    .join('\n')}\n\nfactory config explain <key> says what one means. <name> is a name you choose.\n`;
}
