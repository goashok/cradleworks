// `factory skills`: vendor agent skills into a project and keep them pinned.
//
// A skill is a folder with a SKILL.md (front matter `name` and `description`, then instructions)
// and any files it points to. It lives at `.factory/skills/<name>/`, its origin and content hash in
// `.factory/skills.lock`, and a role gets it through `runtime.roles.<role>.skills` (or
// `always_skills`) in factory.yaml. Fetching happens here, on this machine; agent runs only ever
// read the vendored copy from the base branch. Nothing here commits: the result is a change to
// review and commit like any other.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { formatLock, parseLock, parseSkill, skillHash, SKILL_NAME, SKILLS_DIR, SKILLS_LOCK, type SkillFile, type SkillLockEntry, type SkillsLock } from '@cradleworks/core';
import type { ProjectConfig } from '@cradleworks/core';

const run = promisify(execFile);

export interface SkillsIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Every file under a skill folder, as text, paths relative to it. */
export function readSkillFolder(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relative(dir, full).split('\\').join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const readLock = (repoRoot: string): SkillsLock => parseLock(existsSync(join(repoRoot, SKILLS_LOCK)) ? readFileSync(join(repoRoot, SKILLS_LOCK), 'utf8') : undefined);
const writeLock = (repoRoot: string, lock: SkillsLock) => writeFileSync(join(repoRoot, SKILLS_LOCK), formatLock(lock));
const vendoredNames = (repoRoot: string) =>
  existsSync(join(repoRoot, SKILLS_DIR)) ? readdirSync(join(repoRoot, SKILLS_DIR), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];

/** The roles that use each skill, from factory.yaml. */
function usedBy(config: ProjectConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [role, r] of Object.entries(config.runtime.roles)) {
    for (const name of r?.alwaysSkills ?? []) out.set(name, [...(out.get(name) ?? []), `${role} (always)`]);
    for (const name of r?.skills ?? []) if (!(r?.alwaysSkills ?? []).includes(name)) out.set(name, [...(out.get(name) ?? []), role]);
  }
  return out;
}

/** What `factory validate` reports about skills: problems fail it, notes don't. */
export function checkSkills(repoRoot: string, config: ProjectConfig): { problems: string[]; notes: string[]; count: number } {
  const problems: string[] = [];
  const notes: string[] = [];
  const lockText = existsSync(join(repoRoot, SKILLS_LOCK)) ? readFileSync(join(repoRoot, SKILLS_LOCK), 'utf8') : undefined;
  if (lockText !== undefined && lockText.trim()) {
    try {
      JSON.parse(lockText);
    } catch {
      problems.push(`${SKILLS_LOCK} is not valid JSON`);
    }
  }
  const lock = parseLock(lockText);
  const vendored = vendoredNames(repoRoot);
  const users = usedBy(config);
  for (const name of vendored) {
    const dir = join(repoRoot, SKILLS_DIR, name);
    const where = `${SKILLS_DIR}/${name}`;
    const files = readSkillFolder(dir);
    const manifest = parseSkill(files.find((f) => f.path === 'SKILL.md')?.content ?? '');
    if (!manifest) problems.push(`${where}: needs a SKILL.md with a name and description in its front matter`);
    else if (manifest.name !== name) notes.push(`${where}: SKILL.md names it "${manifest.name}"; roles refer to it by its folder, "${name}"`);
    const entry = lock[name];
    if (!entry) problems.push(`${where} is not in ${SKILLS_LOCK}; add it with factory skills add, or record it as your own with factory skills lock ${name}`);
    else if (entry.hash !== skillHash(files)) problems.push(`${where} doesn't match ${SKILLS_LOCK}: it was changed after it was locked. Run factory skills update ${name} for the locked source, or factory skills lock ${name} to keep the change as your own`);
    if (!users.has(name)) notes.push(`${where} is vendored but no role uses it`);
  }
  for (const name of Object.keys(lock)) if (!vendored.includes(name)) problems.push(`${SKILLS_LOCK} lists ${name}, but ${SKILLS_DIR}/${name}/ is missing`);
  for (const [name, roles] of users) if (!vendored.includes(name)) problems.push(`runtime.roles: ${roles.join(', ')} use the skill "${name}", but ${SKILLS_DIR}/${name}/ is missing`);
  return { problems, notes, count: vendored.length };
}

/**
 * What a skill's files suggest it needs in the image, as commands that succeed when it's there.
 * A guess from its scripts; the team corrects it with `factory skills require`.
 */
export function guessRequirements(files: SkillFile[]): string[] {
  const out: string[] = [];
  const scripts = files.filter((f) => /\.(py|js|mjs|cjs|ts|sh)$/.test(f.path) || /^#!/.test(f.content));
  const python = scripts.filter((f) => f.path.endsWith('.py') || /^#!.*python/.test(f.content));
  const node = scripts.filter((f) => /\.(js|mjs|cjs|ts)$/.test(f.path) || /^#!.*node/.test(f.content));
  if (python.length) out.push('python3 --version');
  if (python.some((f) => /^\s*(from|import)\s+playwright\b/m.test(f.content))) {
    // Imports and launches a browser: the package alone isn't enough without one installed.
    out.push('python3 -c "from playwright.sync_api import sync_playwright as p; b = p().start().chromium.launch(); b.close()"');
  }
  if (node.length) out.push('node --version');
  if (node.some((f) => /from\s+['"]@?playwright|require\(['"]@?playwright/.test(f.content))) out.push('node -e "require.resolve(\'playwright\')"');
  return out;
}

/** Runs each command in the project's image; returns the ones that failed, with why. */
export type RequirementRunner = (command: string) => Promise<{ ok: boolean; detail: string }>;

/** For `factory validate`: each skill a role uses, checked against the image. */
export async function checkRequirements(
  repoRoot: string,
  config: ProjectConfig,
  runner: RequirementRunner | undefined,
): Promise<{ problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  const lock = readLock(repoRoot);
  const users = usedBy(config);
  for (const [name, entry] of Object.entries(lock)) {
    if (!users.has(name) || !entry.requires?.length) continue;
    if (!runner) {
      notes.push(`could not check what skill ${name} needs (${entry.requires.join('; ')}) in ${config.stack.image}`);
      continue;
    }
    for (const command of entry.requires) {
      const result = await runner(command);
      if (!result.ok) problems.push(`skill ${name} needs \`${command}\` to work, and it fails in ${config.stack.image}${result.detail ? `: ${result.detail}` : ''}. Add it to the image, or change what the skill needs with factory skills require ${name}`);
    }
  }
  return { problems, notes };
}

/** A git URL, as opposed to a folder on this machine. */
const isGitUrl = (s: string) => /^(https?:\/\/|git@|ssh:\/\/|git\+)/.test(s) || s.endsWith('.git');

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Fetches a source into a scratch folder; returns the skill folder in it and what it resolved to. */
async function fetchSource(source: string, path: string | undefined, ref: string | undefined, cwd: string): Promise<{ dir: string; scratch?: string; commit?: string }> {
  if (!isGitUrl(source)) {
    const dir = resolve(cwd, source, path ?? '');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    return { dir };
  }
  const url = source.replace(/^git\+/, '');
  const scratch = mkdtempSync(join(tmpdir(), 'cw-skill-'));
  await git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', url, scratch]);
  await git(['checkout', '--quiet', ref ?? 'HEAD'], scratch);
  const commit = await git(['rev-parse', 'HEAD'], scratch);
  const dir = join(scratch, path ?? '');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`${path ?? '.'} is not a folder in ${url}`);
  }
  return { dir, scratch, commit };
}

function show(io: SkillsIo, name: string, files: SkillFile[]): void {
  io.stdout(`\n${name}: ${files.length} file(s)\n`);
  for (const f of files) io.stdout(`  ${f.path}  ${Buffer.byteLength(f.content)} bytes\n`);
  const skill = files.find((f) => f.path === 'SKILL.md');
  if (skill) io.stdout(`\n--- SKILL.md ---\n${skill.content.trimEnd()}\n--- end ---\n`);
  const scripts = files.filter((f) => /\.(sh|py|js|ts|rb|pl)$/.test(f.path) || /^#!/.test(f.content));
  if (scripts.length) io.stdout(`\nIt has ${scripts.length} script(s) an agent may run inside the sandbox: ${scripts.map((f) => f.path).join(', ')}. Read them before you commit.\n`);
}

function copyInto(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes('.git') });
}

const USAGE = `factory skills list
factory skills add <git-url | folder> [--path <dir>] [--ref <ref>] [--name <name>] [--requires <command>]...
factory skills update <name> [--ref <ref>]
factory skills lock <name>
factory skills require <name> [<command>...]
`;

function showRequires(io: SkillsIo, name: string, requires: string[], guessed: boolean): void {
  if (!requires.length) return;
  io.stdout(`\n${guessed ? 'From its scripts, it looks like it needs' : 'It needs'} these to succeed in the project's image (factory validate checks them):\n${requires.map((r) => `  ${r}`).join('\n')}\n${guessed ? `Change them with factory skills require ${name} <command>... (none to drop them).\n` : ''}`);
}

export async function skillsCommand(args: string[], io: SkillsIo, repoRoot: string, config: ProjectConfig): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { path: { type: 'string' }, ref: { type: 'string' }, name: { type: 'string' }, requires: { type: 'string', multiple: true } } });
  const lock = readLock(repoRoot);
  try {
    switch (sub) {
      case 'list': {
        const users = usedBy(config);
        const names = vendoredNames(repoRoot);
        if (!names.length) io.stdout(`No skills in ${SKILLS_DIR}/.\n`);
        for (const name of names) {
          const entry = lock[name];
          const files = readSkillFolder(join(repoRoot, SKILLS_DIR, name));
          const state = !entry ? 'not locked' : entry.hash === skillHash(files) ? 'locked' : 'changed since locked';
          const from = entry ? (entry.source === 'local' ? 'your own' : `${entry.source}${entry.path ? ` ${entry.path}` : ''}${entry.commit ? ` @ ${entry.commit.slice(0, 12)}` : ''}`) : '';
          io.stdout(`${name}  ${state}${from ? `, from ${from}` : ''}; used by ${users.get(name)?.join(', ') ?? 'no role'}\n`);
        }
        return 0;
      }
      case 'add': {
        const source = positionals[0];
        if (!source || positionals.length > 1) throw new Error('add takes one source: a git URL or a folder');
        const fetched = await fetchSource(source, values.path, values.ref, io.cwd);
        try {
          const files = readSkillFolder(fetched.dir);
          const manifest = parseSkill(files.find((f) => f.path === 'SKILL.md')?.content ?? '');
          if (!manifest) throw new Error(`${values.path ?? source} has no SKILL.md with a name and description; is --path right?`);
          const name = values.name ?? manifest.name;
          if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a usable skill name (lowercase letters, digits and dashes); pass --name`);
          const target = join(repoRoot, SKILLS_DIR, name);
          if (existsSync(target)) throw new Error(`${SKILLS_DIR}/${name} already exists; use factory skills update ${name}`);
          copyInto(fetched.dir, target);
          const local = !isGitUrl(source);
          const entry: SkillLockEntry = local
            ? { source: 'local', hash: skillHash(files) }
            : { source: source.replace(/^git\+/, ''), ...(values.path ? { path: values.path } : {}), ...(values.ref ? { ref: values.ref } : {}), ...(fetched.commit ? { commit: fetched.commit } : {}), hash: skillHash(files) };
          const requires = values.requires ?? guessRequirements(files);
          if (requires.length) entry.requires = requires;
          writeLock(repoRoot, { ...lock, [name]: entry });
          show(io, name, files);
          showRequires(io, name, requires, !values.requires);
          io.stdout(`\nVendored into ${SKILLS_DIR}/${name}/ and pinned in ${SKILLS_LOCK}. Nothing is committed: review it, then give it to a role in factory.yaml\n  runtime:\n    roles:\n      <role>:\n        skills: [${name}]\nand commit. It takes effect once merged; changes under .factory/ always wait for a person.\n`);
          return 0;
        } finally {
          if (fetched.scratch) rmSync(fetched.scratch, { recursive: true, force: true });
        }
      }
      case 'update': {
        const name = positionals[0];
        const entry = name ? lock[name] : undefined;
        if (!name || !entry) throw new Error(`${name ?? 'update'} is not in ${SKILLS_LOCK}`);
        if (entry.source === 'local') throw new Error(`${name} is your own skill; edit it in ${SKILLS_DIR}/${name}/ and run factory skills lock ${name}`);
        const fetched = await fetchSource(entry.source, entry.path, values.ref ?? entry.ref, io.cwd);
        try {
          const files = readSkillFolder(fetched.dir);
          if (!parseSkill(files.find((f) => f.path === 'SKILL.md')?.content ?? '')) throw new Error('the new version has no SKILL.md with a name and description');
          const target = join(repoRoot, SKILLS_DIR, name);
          const before = existsSync(target) ? readSkillFolder(target) : [];
          if (skillHash(before) === skillHash(files)) {
            io.stdout(`${name} is already at ${fetched.commit?.slice(0, 12) ?? 'that version'}.\n`);
            return 0;
          }
          const diff = await run('git', ['diff', '--no-index', '--stat', '--', target, fetched.dir]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
          copyInto(fetched.dir, target);
          writeLock(repoRoot, { ...lock, [name]: { ...entry, ...(values.ref ? { ref: values.ref } : {}), ...(fetched.commit ? { commit: fetched.commit } : {}), hash: skillHash(files) } });
          io.stdout(`${diff.stdout}`);
          show(io, name, files);
          const newly = guessRequirements(files).filter((r) => !(entry.requires ?? []).includes(r));
          if (newly.length) io.stdout(`\nThe new version's scripts suggest it may also need:\n${newly.map((r) => `  ${r}`).join('\n')}\nAdd them with factory skills require ${name} <command>...\n`);
          io.stdout(`\nUpdated ${SKILLS_DIR}/${name}/ to ${fetched.commit?.slice(0, 12) ?? 'the new version'}. Review the change (git diff) and commit it.\n`);
          return 0;
        } finally {
          if (fetched.scratch) rmSync(fetched.scratch, { recursive: true, force: true });
        }
      }
      case 'lock': {
        const name = positionals[0];
        const dir = name ? join(repoRoot, SKILLS_DIR, name) : '';
        if (!name || !existsSync(dir)) throw new Error(`no skill ${name ?? ''} in ${SKILLS_DIR}/`);
        const files = readSkillFolder(dir);
        if (!parseSkill(files.find((f) => f.path === 'SKILL.md')?.content ?? '')) throw new Error(`${SKILLS_DIR}/${name} needs a SKILL.md with a name and description`);
        const before = lock[name];
        // A changed copy of someone else's skill is now the team's own; say where it came from.
        const entry: SkillLockEntry =
          before && before.source !== 'local' && before.hash !== skillHash(files)
            ? { source: 'local', path: `forked from ${before.source}${before.path ? ` ${before.path}` : ''}${before.commit ? ` @ ${before.commit}` : ''}`, hash: skillHash(files), ...(before.requires ? { requires: before.requires } : {}) }
            : { ...(before ?? { source: 'local' }), hash: skillHash(files) };
        writeLock(repoRoot, { ...lock, [name]: entry });
        io.stdout(`Locked ${name} as it is now${entry.source === 'local' && before?.source !== 'local' && before ? ` (now your own, ${entry.path})` : ''}.\n`);
        return 0;
      }
      case 'require': {
        const [name, ...commands] = positionals;
        const entry = name ? lock[name] : undefined;
        if (!name || !entry) throw new Error(`${name ?? 'require'} is not in ${SKILLS_LOCK}`);
        const { requires: _old, ...rest } = entry;
        writeLock(repoRoot, { ...lock, [name]: commands.length ? { ...rest, requires: commands } : rest });
        io.stdout(commands.length ? `${name} now needs:\n${commands.map((c) => `  ${c}`).join('\n')}\n` : `${name} needs nothing checked.\n`);
        return 0;
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    io.stderr(`factory skills: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
