// A config variant: one change to how the factory works, to measure against the factory as it is.
//
//   name: opus-reviewer
//   description: A stronger model for the reviewer
//   config:                          # laid over .factory/factory.yaml: maps merge, lists replace,
//     runtime:                       # null removes a key
//       roles: { reviewer: { model: claude-opus-5-5 } }
//   files:                           # files in the repository: new text, a file next to this one,
//     .factory/prompts/reviewer.md: |    # or null to remove (a folder too)
//       Check every migration can be rolled back.
//     .factory/skills/old-skill: null
//     .factory/rules/api.md: { from: ./api-rule.md }
//
// A variant can switch a skill on or off, change a model, a rule, a prompt addition, an agent
// check: anything under .factory/. The eval then applies its own fixed settings on top (local
// git, no CI or tracker, the change gate decided by the reviewer and merged), so gates are not
// something a variant can change.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { overlay, parseYaml, stringifyYaml } from '@cradleworks/config';

export interface Variant {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  /** Repository path to new text, or null to remove it. */
  files: Record<string, string | null>;
  /** sha256 of the variant's content, so results say exactly what ran. */
  hash: string;
}

export function loadVariant(file: string): Variant {
  const path = resolve(file);
  const raw = parseYaml(readFileSync(path, 'utf8'), basename(path));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${basename(path)}: a variant is a mapping with config and/or files`);
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['name', 'description', 'config', 'files'].includes(key)) throw new Error(`${basename(path)}: unknown key ${key} (name, description, config, files)`);
  const files: Record<string, string | null> = {};
  for (const [p, v] of Object.entries((r.files as Record<string, unknown> | undefined) ?? {})) {
    if (p.startsWith('/') || p.split('/').includes('..')) throw new Error(`${basename(path)}: files.${p} must be a path inside the repository`);
    if (v === null) files[p] = null;
    else if (typeof v === 'string') files[p] = v;
    else if (v && typeof v === 'object' && typeof (v as { from?: unknown }).from === 'string') files[p] = readFileSync(resolve(dirname(path), (v as { from: string }).from), 'utf8');
    else throw new Error(`${basename(path)}: files.${p} must be text, { from: <file> } or null`);
  }
  const config = r.config === undefined ? undefined : (r.config as Record<string, unknown>);
  if (config !== undefined && (typeof config !== 'object' || Array.isArray(config) || config === null)) throw new Error(`${basename(path)}: config must be a mapping`);
  const hash = `sha256:${createHash('sha256').update(JSON.stringify({ config: config ?? null, files: Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)) })).digest('hex')}`;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : basename(path).replace(/\.ya?ml$/, '');
  return { name, ...(typeof r.description === 'string' ? { description: r.description } : {}), ...(config ? { config } : {}), files, hash };
}

const FACTORY_YAML = '.factory/factory.yaml';

/** What every eval run uses, whatever the variant: a local copy, merged by the reviewer's verdict. */
export const EVAL_SETTINGS = {
  adapters: { scm: 'local-git', ci: 'none', tracker: 'none' },
  gates: { change_approval: 'ai', auto_merge: true },
  related_repos: [],
};

/** Writes the variant (if any) and the eval's own settings into a checkout. */
export function applyVariant(dir: string, variant: Variant | undefined): void {
  for (const [p, text] of Object.entries(variant?.files ?? {})) {
    const target = join(dir, p);
    if (text === null) rmSync(target, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  const yamlPath = join(dir, FACTORY_YAML);
  if (!existsSync(yamlPath)) throw new Error(`the project has no ${FACTORY_YAML} at the task's base commit`);
  let config = parseYaml(readFileSync(yamlPath, 'utf8'), FACTORY_YAML);
  if (variant?.config) config = overlay(config, variant.config);
  config = overlay(config, EVAL_SETTINGS);
  writeFileSync(yamlPath, stringifyYaml(config));
}
