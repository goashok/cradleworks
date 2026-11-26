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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Lays the repository's `.factory/` as of commit `from` over a checkout of an older commit, so a
 * task taken from before the project had today's settings runs with them. The checkout's own
 * `.factory/specs/` stays as it was: specs written later would include the one for the very issue
 * a task asks for.
 */
export function overlaySettings(gitDir: string, from: string, dest: string): void {
  const git = (args: string[]) => execFileSync('git', ['--git-dir', gitDir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  try {
    git(['cat-file', '-e', `${from}^{commit}`]);
  } catch {
    throw new Error(`settings_from ${from} is not in the repository`);
  }
  const entries = git(['ls-tree', '-r', '-z', from, '--', '.factory'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      return { mode: meta.split(' ')[0]!, path };
    })
    .filter((e) => !e.path.startsWith('.factory/specs/'));
  if (!entries.some((e) => e.path === FACTORY_YAML)) throw new Error(`settings_from ${from} has no ${FACTORY_YAML}`);
  const root = join(dest, '.factory');
  if (existsSync(root)) for (const name of readdirSync(root)) if (name !== 'specs') rmSync(join(root, name), { recursive: true, force: true });
  for (const e of entries) {
    const target = join(dest, e.path);
    mkdirSync(dirname(target), { recursive: true });
    const body = git(['cat-file', 'blob', `${from}:${e.path}`]);
    if (e.mode === '120000') symlinkSync(body.toString('utf8'), target);
    else {
      writeFileSync(target, body);
      if (e.mode === '100755') chmodSync(target, 0o755);
    }
  }
}

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
