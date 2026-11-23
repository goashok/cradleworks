import type { StoredEvent } from '@cradleworks/interfaces';
import type { Task, WorkItem } from '@cradleworks/core';
import { describe, expect, it } from 'vitest';
import { headline, runBody, specSection, story, taskCard, withoutAnswer } from './console-view.ts';

const task = (over: Partial<Task> = {}): Task => ({ id: 'task_1', specId: 'spec_1', title: 'Add export', dependsOn: [], size: 'small', state: 'building', reworkLoops: 0, gateReworks: 0, extraLoops: 0, changeApproved: false, spentUsd: 0.4, ...over });
const wi = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'wi_1',
  source: { id: 'o/r#1', url: 'https://example.com/1' },
  requester: 'sam',
  projectId: 'demo',
  title: 'Export orders',
  state: 'in_progress',
  maxReworkLoops: 3,
  proposedTasks: [],
  spentUsd: 1,
  tasks: [],
  gateDecisions: [],
  runs: [],
  createdAt: '2026-11-23T10:00:00Z',
  updatedAt: '2026-11-23T10:00:00Z',
  version: 1,
  ...over,
});
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, at = '2026-11-23T10:00:00Z'): StoredEvent => ({ streamId: 's', seq: ++seq, position: seq, type, payload, at }) as StoredEvent;
const agent = (event: Record<string, unknown>) => ev('agent_event', { event });
const done = (costUsd: number) => agent({ type: 'done', outcome: 'succeeded', total: { inputTokens: 10, outputTokens: 5, costUsd } });

describe('console views', () => {
  it('says in a sentence where the work stands and when a person is needed', () => {
    expect(headline(wi({ state: 'awaiting_spec_approval' }))).toMatchObject({ needsYou: true, tone: 'wait' });
    expect(headline(wi({ state: 'merged', tasks: [task({ state: 'merged' }), task({ id: 'task_2', state: 'merged' })] })).text).toBe('Done. All 2 tasks are merged.');
    const waiting = headline(wi({ tasks: [task({ state: 'ready', title: 'Add export' })] }));
    expect(waiting).toMatchObject({ needsYou: true });
    expect(waiting.text).toContain('“Add export” — waiting for approval');
    expect(headline(wi({ tasks: [task({ state: 'verifying' }), task({ id: 'task_2', state: 'merged' })] })).text).toBe('1 of 2 tasks merged. Working on: “Add export” (being checked).');
  });

  it('asks nothing of a person once the work item is finished', () => {
    const cancelled = wi({ state: 'cancelled', endReason: 'the issue was closed', tasks: [task({ state: 'failed', lastReason: 'agent failed' })] });
    expect(headline(cancelled)).toMatchObject({ needsYou: false, text: 'Cancelled: the issue was closed.' });
    expect(taskCard(cancelled.tasks[0]!, cancelled, '')).not.toContain('attention');
  });

  it('tells the work item’s events as a story, with who decided each gate', () => {
    const w = wi({ tasks: [task()] });
    const lines = story(w, [
      ev('work_item_received', { requester: 'sam' }),
      ev('gate_decided', { gate: 'spec_approval', mode: 'ai', decidedBy: 'spec checker', verdict: 'rejected', reason: 'criterion 3 is vague' }),
      ev('gate_decided', { gate: 'spec_approval', mode: 'human', decidedBy: 'sam', verdict: 'approved', reason: '' }),
      ev('task_verified', { taskId: 'task_1', verdict: 'rework', reason: 'CI failed: backend' }),
      ev('task_merged', { taskId: 'task_1', sha: 'abc' }),
      ev('agent_cost_recorded', { runId: 'run_1', costUsd: 0.1 }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Request received from sam.',
      'Spec sent back by spec checker, automatically: criterion 3 is vague',
      'Spec approved by sam.',
      '“Add export” checked: sent back for rework — CI failed: backend',
      'Merged “Add export”.',
    ]);
  });

  it('takes the JSON answer off the end of an agent’s message, and nothing else', () => {
    expect(withoutAnswer('Looks fine.\n{"verdict":"pass","reasons":[]}')).toEqual({ text: 'Looks fine.', answered: true });
    expect(withoutAnswer('Done.\n```json\n{"tasks":[{"key":"t1"}]}\n```')).toEqual({ text: 'Done.', answered: true });
    expect(withoutAnswer('{"verdict":"pass"}')).toEqual({ text: '', answered: true });
    expect(withoutAnswer('Use the {name} placeholder')).toEqual({ text: 'Use the {name} placeholder', answered: false });
    expect(withoutAnswer('An unclosed {{#if x} is refused}')).toEqual({ text: 'An unclosed {{#if x} is refused}', answered: false });
  });

  it('opens the spec for reading only while it waits for approval', () => {
    const spec = { id: 'spec_1', workItemId: 'wi_1', version: 1, title: 'T', problem: 'P', acceptanceCriteria: ['a'], outOfScope: [] };
    expect(specSection(spec, wi({ state: 'awaiting_spec_approval' }))).toContain('<details open>');
    expect(specSection(spec, wi({ state: 'merged' }))).not.toContain('<details open>');
  });

  it('folds the checks of a merged task into one line', () => {
    const evidence = { runId: 'run_1', sha: 'abc', checks: [{ name: 'build', command: 'b', outcome: 'passed' as const, durationMs: 1000 }], ci: { state: 'passed' as const, runs: [] }, review: { verdict: 'pass' as const, risk: 'low' as const, reasons: ['ok'], model: 'm' }, verdict: 'pass' as const, reason: 'r', costUsd: 0, verifiedAt: '2026-11-23T10:00:00Z' };
    const merged = taskCard(task({ state: 'merged', evidence }), wi(), '');
    expect(merged).toContain('<details class="evidence"><summary><b>Latest check</b>');
    expect(merged).toContain('1 check passed · CI passed · reviewer: pass, low risk');
    expect(taskCard(task({ state: 'verifying', evidence }), wi(), '')).not.toContain('<details class="evidence">');
  });

  it('shows a verify run as its verdict, each agent by its role, and agent text escaped', () => {
    const events = [
      ev('run_context', { workItemId: 'wi_1', taskId: 'task_1', station: 'verify' }),
      ev('check_ran', { name: 'build', command: 'b', outcome: 'passed', durationMs: 2000 }),
      ev('agent_started', { agent: 'a', model: 'm' }),
      agent({ type: 'message', role: 'assistant', text: 'Wrote tests <script>alert(1)</script>' }),
      done(0.16),
      ev('acceptance_tests', { files: ['t.test.ts'] }),
      ev('agent_started', { agent: 'a', model: 'm' }),
      agent({ type: 'tool_call', callId: 'c1', tool: 'Bash', input: { command: 'git diff' } }),
      agent({ type: 'tool_result', callId: 'c1', output: 'diff --git', isError: false }),
      agent({ type: 'message', role: 'assistant', text: 'Needs work.\n{"verdict":"rework","risk":"high","reasons":["pin it"]}' }),
      done(0.08),
      ev('review_decided', { verdict: 'rework', risk: 'high', reasons: ['pin it'], model: 'm' }),
      ev('evidence', { verdict: 'rework', reason: 'reviewer: pin it', sha: 'abc' }),
      ev('run_ended', { outcome: 'succeeded' }),
    ];
    const w = wi({ tasks: [task()], runs: [{ id: 'run_1', subjectId: 'task_1', station: 'verify', startedAt: '2026-11-23T10:00:00Z', endedAt: '2026-11-23T10:01:00Z', outcome: 'succeeded' }] });
    const html = runBody({ runId: 'run_1', events, wi: w, run: w.runs[0]!, cost: 0.08 }, 'raw');
    expect(html).toContain('Sent back for rework');
    expect(html).not.toContain('>Succeeded<');
    expect(html).toContain('cost $0.24');
    expect(html).toContain('Tester: writes acceptance tests from the spec');
    expect(html).toContain('Reviewer: judges the change');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('{&quot;verdict&quot;');
    expect(html).toContain('for the reviewer’s reasons above');
    expect(html).toContain('<a href="/wi/wi_1">Export orders</a> › Add export');
  });
});
