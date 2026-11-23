import { describe, expect, it } from 'vitest';
import { docEntries, docFor, docsUnder, explain, schemaKeys } from './explain.ts';

describe('factory config explain', () => {
  // The reference and the schema must cover the same keys: a key added to one and not the other
  // fails here, so `config explain` never says nothing about a real key or explains a gone one.
  it('every key in the schema is documented in configuration.md, and every documented key exists', () => {
    const docs = docEntries();
    const keys = schemaKeys();
    const undocumented = keys.filter((k) => (k.type === 'a mapping' ? !docsUnder(docs, k.key).length && !docFor(docs, k.key) : !docFor(docs, k.key))).map((k) => k.key);
    expect(undocumented).toEqual([]);
    const gone = docs.filter((d) => !keys.some((k) => d.key.split('.').length === k.key.split('.').length && d.key.split('.').every((s, i) => s === k.key.split('.')[i] || (/^<.+>$/.test(s) && k.key.split('.')[i] !== undefined)))).map((d) => d.key);
    expect(gone).toEqual([]);
  });

  it('explains a key from the schema, the defaults and the reference', () => {
    const e = explain('gates.change_approval');
    expect(e).toMatchObject({ type: 'one of human, ai, skip', required: true, default: 'human', docs: expect.stringContaining('configuration.md#gates') });
    expect(explain('stack.frontend_test')).toMatchObject({ meaning: expect.stringContaining('A further named command') });
    expect(explain('runtime.roles.reviewer.model')).toMatchObject({ meaning: expect.stringContaining('Override the agent or model') });
    expect(explain('project')).toMatchObject({ meaning: expect.stringContaining("project's name") });
    expect(explain('gates')).toMatchObject({ children: ['spec_approval', 'plan_check', 'change_approval', 'auto_merge'], docs: expect.stringContaining('#gates') });
    expect(explain('budgets.per_task_usd')).toMatchObject({ type: 'number > 0', default: '5' });
  });

  it('suggests the key meant', () => {
    expect(explain('budget.per_task_usd')).toEqual({ unknown: 'budget.per_task_usd', suggestions: expect.arrayContaining(['budgets.per_task_usd']) });
  });
});
