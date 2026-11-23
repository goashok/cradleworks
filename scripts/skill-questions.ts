// Asks the cradleworks skill the questions in skills/questions.yaml and checks each answer:
// the commands it ran, what it said, and that it changed nothing it shouldn't.
//
//   node scripts/skill-questions.ts [--model <model>] [<id>...]
//
// Each question runs Claude Code headless in a fresh scratch project with the skill installed
// and only read-only `factory` commands allowed. Costs a few cents with the default model.
// Exit 0 when every answer passes, 1 otherwise.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseYaml } from '../packages/config/src/index.ts';

type Expect = string | string[];
interface Question {
  id: string;
  ask: string;
  ran?: string[];
  mentions?: Expect[];
  not?: string[];
  unchanged?: string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: 'claude-haiku-5-5' } } });
const all = parseYaml(readFileSync(join(root, 'skills', 'questions.yaml'), 'utf8'), 'questions.yaml') as Array<Question | { fixture: Record<string, string> }>;
const fixture = (all.find((q) => 'fixture' in q) as { fixture: Record<string, string> }).fixture;
const questions = (all.filter((q) => 'id' in q) as Question[]).filter((q) => !positionals.length || positionals.includes(q.id));

// Read-only commands only: anything that spends money or changes state is not allowed here.
const READ_ONLY = ['help', 'docs', 'config explain', 'validate', 'status', 'log', 'stats', 'skills list'];
const allowed = ['Read', 'Glob', 'Grep', 'Skill', ...READ_ONLY.map((c) => `Bash(factory ${c}:*)`)];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-skillq-'));
  for (const [path, content] of Object.entries(fixture)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(root, 'skills', 'cradleworks'), join(dir, '.claude', 'skills', 'cradleworks'));
  // `factory` on PATH, as the quick start sets it up.
  mkdirSync(join(dir, '.bin'));
  writeFileSync(join(dir, '.bin', 'factory'), `#!/bin/sh\nexec node ${JSON.stringify(join(root, 'packages', 'cli', 'src', 'main.ts'))} "$@"\n`);
  chmodSync(join(dir, '.bin', 'factory'), 0o755);
  return dir;
}

const has = (text: string, e: Expect) => (Array.isArray(e) ? e : [e]).some((x) => text.toLowerCase().includes(x.toLowerCase()));

let failed = 0;
let cost = 0;
for (const q of questions) {
  const dir = scratch();
  const before = Object.fromEntries((q.unchanged ?? []).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const r = spawnSync('claude', ['-p', q.ask, '--model', values.model!, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...allowed, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, '.bin')}:${process.env.PATH}`, CRADLEWORKS_HOME: join(dir, '.home') },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ran: string[] = [];
  let answer = '';
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    const ev = JSON.parse(line) as { type: string; message?: { content?: Array<{ type: string; name?: string; input?: { command?: string } }> }; result?: string; total_cost_usd?: number };
    for (const c of ev.message?.content ?? []) if (c.type === 'tool_use' && c.name === 'Bash' && c.input?.command) ran.push(c.input.command);
    if (ev.type === 'result') {
      answer = ev.result ?? '';
      cost += ev.total_cost_usd ?? 0;
    }
  }
  const why: string[] = [];
  if (!answer) why.push(`no answer (${(r.stderr || r.error?.message || '').trim().split('\n').at(-1) ?? ''})`);
  // Every part of every command line, with `.bin/factory` read as `factory`.
  const parts = ran.flatMap((x) => x.split(/;|&&|\|\||\||\n/)).map((x) => x.trim().replace(/^(?:\S*\/)?\.bin\/factory\b/, 'factory'));
  for (const c of q.ran ?? []) if (!parts.some((x) => x.startsWith(c))) why.push(`didn't run ${c}`);
  for (const m of q.mentions ?? []) if (!has(answer, m)) why.push(`didn't mention ${Array.isArray(m) ? m.join(' or ') : m}`);
  for (const n of q.not ?? []) if (has(answer, n)) why.push(`mentioned ${n}`);
  for (const [f, text] of Object.entries(before)) if (readFileSync(join(dir, f), 'utf8') !== text) why.push(`changed ${f}`);
  if (why.length) failed++;
  console.log(`${why.length ? 'FAIL' : 'ok  '}  ${q.id}${why.length ? `: ${why.join('; ')}` : ''}`);
  if (why.length) console.log(`        ran: ${ran.join(' | ') || 'nothing'}\n        answer: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${questions.length - failed} of ${questions.length} passed, $${cost.toFixed(2)}`);
process.exit(failed ? 1 : 0);
