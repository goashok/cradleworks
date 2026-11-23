// A small schema for factory.yaml. Validation collects every problem with its path,
// so the loader can point each one at a line in the file that caused it.

import { parseAllowEntry } from '@cradleworks/interfaces';

export type Path = ReadonlyArray<string | number>;

export type Field =
  | { kind: 'string'; required?: boolean; doc?: string }
  | { kind: 'enum'; values: readonly string[]; required?: boolean }
  | { kind: 'number'; required?: boolean; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean }
  | { kind: 'boolean'; required?: boolean }
  /** A string or a list of strings; normalised to a list. */
  | { kind: 'stringList'; required?: boolean; check?: (item: string) => string | undefined }
  | {
      kind: 'object';
      required?: boolean;
      fields: Record<string, Field>;
      /** Schema for keys not listed in `fields`. Absent = unknown keys are errors. */
      extra?: Field;
    };

export interface Issue {
  path: Path;
  message: string;
  /** Unknown keys point at the key itself rather than its value. */
  atKey?: boolean;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const skillName = (item: string) => (SKILL_NAME.test(item) ? undefined : `"${item}" is not a skill name (lowercase letters, digits and dashes)`);

const AGENT_CHOICE: Field = {
  kind: 'object',
  fields: {
    agent: { kind: 'string' },
    model: { kind: 'string' },
    /** Skills in .factory/skills/ the role may open when its task calls for them. */
    skills: { kind: 'stringList', check: skillName },
    /** Skills whose SKILL.md is put into the role's prompt. */
    always_skills: { kind: 'stringList', check: skillName },
  },
};

const GATE_MODE: Field = { kind: 'enum', values: ['human', 'ai', 'skip'], required: true };

export const FACTORY_YAML: Field = {
  kind: 'object',
  required: true,
  fields: {
    project: { kind: 'string', required: true },
    adapters: {
      kind: 'object',
      required: true,
      fields: {
        scm: { kind: 'string', required: true },
        ci: { kind: 'string', required: true },
        tracker: { kind: 'string', required: true },
        sandbox: { kind: 'string', required: true },
        runtime: { kind: 'string', required: true },
      },
    },
    runtime: {
      kind: 'object',
      required: true,
      fields: {
        agent: { kind: 'string', required: true },
        model: { kind: 'string', required: true },
        roles: {
          kind: 'object',
          fields: {
            specifier: AGENT_CHOICE,
            planner: AGENT_CHOICE,
            implementer: AGENT_CHOICE,
            tester: AGENT_CHOICE,
            reviewer: AGENT_CHOICE,
          },
        },
      },
    },
    stack: {
      kind: 'object',
      required: true,
      fields: {
        image: { kind: 'string', required: true },
        build: { kind: 'string', required: true },
        test: { kind: 'string', required: true },
        lint: { kind: 'string' },
      },
      extra: { kind: 'string' },
    },
    context: {
      kind: 'object',
      required: true,
      fields: {
        include: { kind: 'stringList', required: true },
        rules: { kind: 'stringList', required: true },
      },
    },
    gates: {
      kind: 'object',
      required: true,
      fields: {
        spec_approval: GATE_MODE,
        plan_check: GATE_MODE,
        change_approval: GATE_MODE,
        auto_merge: { kind: 'boolean', required: true },
      },
    },
    budgets: {
      kind: 'object',
      required: true,
      fields: {
        per_task_usd: { kind: 'number', required: true, min: 0, exclusiveMin: true },
        per_user_daily_usd: { kind: 'number', min: 0, exclusiveMin: true },
        per_user_monthly_usd: { kind: 'number', min: 0, exclusiveMin: true },
        max_rework_loops: { kind: 'number', required: true, min: 0, integer: true },
      },
    },
    specs: { kind: 'enum', values: ['repo', 'factory'], required: true },
    concurrency: { kind: 'number', required: true, min: 1, integer: true },
    verify: {
      kind: 'object',
      required: true,
      fields: {
        tester: { kind: 'boolean', required: true },
        /** Further reviewers with one focus each, keyed by name. */
        agent_checks: {
          kind: 'object',
          fields: {},
          extra: {
            kind: 'object',
            fields: {
              skill: { kind: 'string', required: true },
              blocks: { kind: 'boolean' },
              max_share: { kind: 'number', min: 0, exclusiveMin: true, max: 1 },
              agent: { kind: 'string' },
              model: { kind: 'string' },
            },
          },
        },
      },
    },
    related_repos: { kind: 'stringList', required: true },
    protected_paths: { kind: 'stringList', required: true },
    sandbox: {
      kind: 'object',
      required: true,
      fields: {
        commands: {
          kind: 'object',
          required: true,
          fields: { deny: { kind: 'stringList', required: true } },
        },
        network: {
          kind: 'object',
          required: true,
          fields: {
            mode: { kind: 'enum', values: ['none', 'allowlist'], required: true },
            allow: {
              kind: 'stringList',
              required: true,
              check: (item) => {
                const parsed = parseAllowEntry(item);
                return 'error' in parsed ? parsed.error : undefined;
              },
            },
          },
        },
      },
    },
  },
};

export function validate(value: unknown, field: Field, path: Path = [], issues: Issue[] = []): Issue[] {
  const where = path.length === 0 ? 'the file' : path.join('.');

  if (value === undefined || value === null) {
    if (field.required) issues.push({ path, message: `${where} is required` });
    return issues;
  }

  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') issues.push({ path, message: `${where} must be a string (got ${describe(value)})` });
      else if (value.trim() === '') issues.push({ path, message: `${where} must not be empty` });
      break;

    case 'enum':
      if (typeof value !== 'string' || !field.values.includes(value)) {
        const hint = typeof value === 'string' ? didYouMean(value, field.values) : '';
        issues.push({ path, message: `${where} must be one of ${field.values.join(', ')} (got ${describe(value)})${hint}` });
      }
      break;

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `${where} must be a number (got ${describe(value)})` });
        break;
      }
      if (field.integer && !Number.isInteger(value)) issues.push({ path, message: `${where} must be a whole number (got ${value})` });
      if (field.min !== undefined) {
        const tooSmall = field.exclusiveMin ? value <= field.min : value < field.min;
        if (tooSmall) {
          const bound = field.exclusiveMin ? `greater than ${field.min}` : `at least ${field.min}`;
          issues.push({ path, message: `${where} must be ${bound} (got ${value})` });
        }
      }
      if (field.max !== undefined && value > field.max) issues.push({ path, message: `${where} must be at most ${field.max} (got ${value})` });
      break;
    }

    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: `${where} must be true or false (got ${describe(value)})` });
      break;

    case 'stringList': {
      const items = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(items)) {
        issues.push({ path, message: `${where} must be a string or a list of strings (got ${describe(value)})` });
        break;
      }
      items.forEach((item, i) => {
        if (typeof item !== 'string' || item.trim() === '') {
          issues.push({ path: [...path, i], message: `${where}[${i}] must be a non-empty string (got ${describe(item)})` });
        } else {
          const problem = field.check?.(item);
          if (problem) issues.push({ path: typeof value === 'string' ? path : [...path, i], message: `${where}: ${problem}` });
        }
      });
      break;
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: `${where} must be a mapping of keys to values (got ${describe(value)})` });
        break;
      }
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(field.fields)) validate(record[key], child, [...path, key], issues);
      for (const key of Object.keys(record)) {
        if (key in field.fields) continue;
        if (field.extra) {
          validate(record[key], field.extra, [...path, key], issues);
        } else {
          const name = path.length === 0 ? key : `${path.join('.')}.${key}`;
          issues.push({ path: [...path, key], atKey: true, message: `unknown key ${name}${didYouMean(key, Object.keys(field.fields))}` });
        }
      }
      break;
    }
  }
  return issues;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function didYouMean(input: string, options: readonly string[]): string {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const option of options) {
    const d = distance(input.toLowerCase(), option.toLowerCase());
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(best.length / 4)) ? `; did you mean ${best}?` : '';
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}
