import { describe, expect, it } from 'vitest';
import { parsePlan } from './issue-flow.ts';
import { jsonObjects, parseReview } from './verify.ts';

describe('reading JSON from an agent answer', () => {
  it('skips braces inside strings, so quoted code does not break the plan', () => {
    const plan = {
      tasks: [
        { key: 't1', title: 'Reject unclosed blocks', description: 'Reject an unclosed `{{#if x` and a stray `}` in a template.', size: 'small', depends_on: [], criteria: [1] },
        { key: 't2', title: 'Render', description: 'Render `{{ name }}` with spaces; a backslash-escaped `\\{{` stays literal.', size: 'small', depends_on: ['t1'], criteria: [2] },
      ],
    };
    const text = `I split this into two tasks.\n\n${JSON.stringify(plan)}`;
    expect(parsePlan(text)?.map((t) => t.key)).toEqual(['t1', 't2']);
  });

  it('passes over a { in prose that never closes', () => {
    const text = 'The template opens with { and I fixed it.\n{"verdict": "pass", "risk": "low", "reasons": []}';
    expect(parseReview(text, 'm').verdict).toBe('pass');
  });

  it('takes the last object when there are several', () => {
    const text = 'Earlier: {"verdict": "rework", "reasons": ["x"]}\nFinal: {"verdict": "pass", "risk": "low", "reasons": []}';
    expect(parseReview(text, 'm').verdict).toBe('pass');
    expect(jsonObjects(text)).toHaveLength(2);
  });

  it('ignores prose in braces that is not JSON', () => {
    expect(jsonObjects('see /v1/templates/{name} and {not json}')).toEqual([]);
  });
});
