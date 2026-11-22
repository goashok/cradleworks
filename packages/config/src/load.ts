// Loads `.factory/factory.yaml`, merges it over the factory defaults, validates the result
// and returns the core's ProjectConfig. Every problem is reported with the file, line and
// column it came from, all at once.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateMode, ProjectConfig } from '@cradleworks/core';
import { isMap, isScalar, LineCounter, parseDocument, type Document } from 'yaml';
import { FACTORY_YAML, validate, type Issue, type Path } from './schema.ts';

export const PROJECT_CONFIG_PATH = join('.factory', 'factory.yaml');
export const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'defaults', 'factory.yaml');

export interface ConfigIssue {
  /** File as shown to the person, e.g. ".factory/factory.yaml". */
  file: string;
  /** 1-based; absent when the problem is not tied to a line (e.g. a missing file). */
  line?: number;
  col?: number;
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(issues.map(formatIssue).join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatIssue(issue: ConfigIssue): string {
  const at = issue.line === undefined ? issue.file : `${issue.file}:${issue.line}:${issue.col ?? 1}`;
  return `${at}  ${issue.message}`;
}

export interface SourceText {
  /** Name shown in errors. */
  file: string;
  text: string;
}

/** Reads `<repoRoot>/.factory/factory.yaml` and the defaults file from disk. */
export function loadProjectConfig(repoRoot: string, options: { defaultsPath?: string } = {}): ProjectConfig {
  const projectPath = join(repoRoot, PROJECT_CONFIG_PATH);
  const defaultsPath = options.defaultsPath ?? DEFAULTS_PATH;
  const missing = [
    { path: projectPath, file: PROJECT_CONFIG_PATH },
    { path: defaultsPath, file: defaultsPath },
  ].filter((f) => !existsSync(f.path));
  if (missing.length > 0) {
    throw new ConfigError(missing.map((f) => ({ file: f.file, path: '', message: 'file not found' })));
  }
  return parseProjectConfig(
    { file: PROJECT_CONFIG_PATH, text: readFileSync(projectPath, 'utf8') },
    { file: 'factory defaults', text: readFileSync(defaultsPath, 'utf8') },
  );
}

interface Parsed {
  source: SourceText;
  doc: Document.Parsed;
  lines: LineCounter;
  value: unknown;
}

/** Parses and validates from text; `defaults` supplies any key the project omits. */
export function parseProjectConfig(project: SourceText, defaults?: SourceText): ProjectConfig {
  const parsed = [defaults, project].filter((s): s is SourceText => s !== undefined).map(parse);
  const syntax = parsed.flatMap(syntaxIssues);
  if (syntax.length > 0) throw new ConfigError(syntax);

  const top = parsed.flatMap((p) =>
    p.value === null || p.value === undefined || isPlainObject(p.value)
      ? []
      : [{ file: p.source.file, line: 1, col: 1, path: '', message: 'the file must be a mapping of keys to values' }],
  );
  if (top.length > 0) throw new ConfigError(top);

  const merged = parsed.reduce<unknown>((acc, p) => merge(acc, p.value ?? {}), {});
  const projectParsed = parsed.at(-1)!;
  const issues = validate(merged, FACTORY_YAML).map((issue) => locate(issue, parsed, projectParsed));
  if (issues.length > 0) throw new ConfigError(issues.sort(byPosition));

  return toProjectConfig(merged as RawConfig);
}

// --- parsing and positions ---------------------------------------------------

function parse(source: SourceText): Parsed {
  const lines = new LineCounter();
  const doc = parseDocument(source.text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  return { source, doc, lines, value: doc.errors.length > 0 ? undefined : doc.toJS() };
}

function syntaxIssues(p: Parsed): ConfigIssue[] {
  return p.doc.errors.map((error) => {
    const pos = p.lines.linePos(error.pos[0]);
    return { file: p.source.file, line: pos.line, col: pos.col, path: '', message: firstLine(error.message) };
  });
}

/** Points an issue at the file that set the offending value, or the nearest place it should go. */
function locate(issue: Issue, parsed: Parsed[], project: Parsed): ConfigIssue {
  const path = issue.path.join('.');
  // Latest file first: the project overrides the defaults.
  for (const p of [...parsed].reverse()) {
    const offset = issue.atKey ? keyOffset(p.doc, issue.path) : valueOffset(p.doc, issue.path);
    if (offset !== undefined) return at(p, offset, path, issue.message);
  }
  // Not set anywhere (a required key is missing): point at its parent in the project file.
  for (let depth = issue.path.length - 1; depth > 0; depth--) {
    const offset = keyOffset(project.doc, issue.path.slice(0, depth));
    if (offset !== undefined) return at(project, offset, path, issue.message);
  }
  return { file: project.source.file, line: 1, col: 1, path, message: issue.message };
}

function at(p: Parsed, offset: number, path: string, message: string): ConfigIssue {
  const pos = p.lines.linePos(offset);
  return { file: p.source.file, line: pos.line, col: pos.col, path, message };
}

function valueOffset(doc: Document.Parsed, path: Path): number | undefined {
  if (path.length === 0) return doc.contents?.range?.[0];
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  return node?.range?.[0] ?? keyOffset(doc, path);
}

function keyOffset(doc: Document.Parsed, path: Path): number | undefined {
  if (path.length === 0) return undefined;
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  const last = path.at(-1);
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === last);
  return pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
}

// --- merge and mapping -------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps merge key by key; anything else in `over` replaces `base`. */
function merge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
  return out;
}

type RawGate = 'human' | 'ai' | 'skip';
interface RawConfig {
  project: string;
  adapters: ProjectConfig['adapters'];
  runtime: { agent: string; model: string; roles?: ProjectConfig['runtime']['roles'] };
  stack: { image: string; build: string; test: string; [name: string]: string };
  context: { include: string | string[]; rules: string | string[] };
  gates: { spec_approval: RawGate; plan_check: RawGate; change_approval: RawGate; auto_merge: boolean };
  budgets: { per_task_usd: number; per_user_daily_usd?: number; per_user_monthly_usd?: number; max_rework_loops: number };
  specs: 'repo' | 'factory';
  concurrency: number;
  verify: { tester: boolean };
  related_repos: string | string[];
  sandbox: { network: { mode: 'none' | 'allowlist'; allow: string | string[] } };
}

const list = (v: string | string[]): string[] => (typeof v === 'string' ? [v] : [...v]);
const gate = (v: RawGate): GateMode => (v === 'skip' ? 'skipped' : v);

function toProjectConfig(raw: RawConfig): ProjectConfig {
  const { image, ...commands } = raw.stack;
  const budgets: ProjectConfig['budgets'] = {
    perTaskUsd: raw.budgets.per_task_usd,
    maxReworkLoops: raw.budgets.max_rework_loops,
  };
  if (raw.budgets.per_user_daily_usd !== undefined) budgets.perUserDailyUsd = raw.budgets.per_user_daily_usd;
  if (raw.budgets.per_user_monthly_usd !== undefined) budgets.perUserMonthlyUsd = raw.budgets.per_user_monthly_usd;

  return {
    project: raw.project,
    adapters: { ...raw.adapters },
    runtime: { agent: raw.runtime.agent, model: raw.runtime.model, roles: raw.runtime.roles ?? {} },
    stack: { image, commands },
    context: { include: list(raw.context.include), rules: list(raw.context.rules) },
    gates: {
      specApproval: gate(raw.gates.spec_approval),
      planCheck: gate(raw.gates.plan_check),
      changeApproval: gate(raw.gates.change_approval),
      autoMerge: raw.gates.auto_merge,
    },
    budgets,
    specs: raw.specs,
    concurrency: raw.concurrency,
    verify: { tester: raw.verify.tester },
    relatedRepos: list(raw.related_repos),
    network: { mode: raw.sandbox.network.mode, allow: list(raw.sandbox.network.allow) },
  };
}

function byPosition(a: ConfigIssue, b: ConfigIssue): number {
  return a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0);
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}
