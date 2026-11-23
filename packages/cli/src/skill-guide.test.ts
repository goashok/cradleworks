// The cradleworks skill (skills/cradleworks/) points at docs sections, factory.yaml keys and
// commands instead of restating them. This keeps the pointers true: rename a section, a key or a
// flag, and this fails until the skill follows.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findTopic, loadTopics } from './docs.ts';
import { explain } from './explain.ts';
import { run } from './index.ts';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'cradleworks');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []));
const text = files(SKILL).map((f) => ({ f: f.slice(SKILL.length + 1), body: readFileSync(f, 'utf8') }));
// Commands as the skill writes them, in backticks.
const spans = text.flatMap(({ f, body }) => [...body.matchAll(/`(factory [^`]+)`/g)].map((m) => ({ f, cmd: m[1]! })));

async function usage(): Promise<string> {
  let out = '';
  await run(['help'], { cwd: process.cwd(), env: {}, stdout: (t) => (out += t), stderr: (t) => (out += t) });
  return out;
}

describe('the cradleworks skill', () => {
  it('has a name and a description the assistant can match on', () => {
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: cradleworks\ndescription: .{100,}\n---/);
  });

  it('names only docs sections that exist', () => {
    const topics = loadTopics();
    const missing: string[] = [];
    for (const { f, cmd } of spans) {
      const m = /^factory docs ([a-z][\w-]*)(?: "([^"]+)")?/.exec(cmd);
      if (!m) continue;
      const topic = findTopic(topics, m[1]!);
      if (!topic || topic.name !== m[1]) missing.push(`${f}: no topic ${m[1]}`);
      else if (m[2] && !topic.sections.some((s) => s.heading === m[2])) missing.push(`${f}: no section "${m[2]}" in ${m[1]}`);
    }
    expect(missing).toEqual([]);
    expect(spans.filter((s) => s.cmd.startsWith('factory docs ')).length).toBeGreaterThan(20);
  });

  it('names only factory.yaml keys that exist', () => {
    const keys = spans.map((s) => /^factory config explain ([a-z][\w.<>]*)$/.exec(s.cmd)?.[1]).filter((k): k is string => !!k);
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.filter((k) => 'unknown' in explain(k))).toEqual([]);
  });

  it('names only commands and flags the CLI has', async () => {
    const help = await usage();
    const commands = new Set([...help.matchAll(/^\s+factory ([a-z]+)/gm)].map((m) => m[1]!));
    const cliRef = readFileSync(join(SKILL, '..', '..', 'docs', 'reference', 'cli.md'), 'utf8');
    const bad: string[] = [];
    for (const { f, cmd } of spans) {
      const [, word, sub] = /^factory ([a-z]+)(?: ([a-z]+))?/.exec(cmd) ?? [];
      if (!word) continue;
      if (word !== 'help' && !commands.has(word)) bad.push(`${f}: no command ${word}`);
      // A subcommand (`skills add`, `eval run`) must be in the usage text or the CLI reference.
      if (sub && !['docs', 'config', 'help', 'status', 'log', 'drill', 'watch', 'validate', 'stats', 'submit'].includes(word) && !help.includes(`${word} ${sub}`) && !cliRef.includes(`${word} ${sub}`) && !cliRef.includes(`\`${sub}`)) bad.push(`${f}: no ${word} ${sub}`);
      for (const flag of cmd.match(/--[a-z-]+/g) ?? []) if (!help.includes(flag)) bad.push(`${f}: no flag ${flag} (${cmd})`);
    }
    expect(bad).toEqual([]);
  });

  it('links only to files it has', () => {
    const broken = text.flatMap(({ f, body }) => [...body.matchAll(/\]\(([^)#]+\.md)\)/g)].map((m) => m[1]!).filter((p) => !existsSync(join(SKILL, dirname(f), p))).map((p) => `${f}: ${p}`));
    expect(broken).toEqual([]);
  });
});
