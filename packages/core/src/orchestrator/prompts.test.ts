import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/types.ts';
import { specifierPrompt, testerPrompt } from './issue-flow.ts';
import { implementerPrompt, reviewerPrompt, WAITING_RULE } from './prompts.ts';

const config = { stack: { image: 'x', commands: { build: 'make', test: 'make test' } } } as unknown as ProjectConfig;

describe('role prompts', () => {
  it('tell every agent that runs commands not to wait on a process with a loop that matches itself', () => {
    expect(WAITING_RULE).toMatch(/pgrep -f/);
    expect(implementerPrompt(config, [])).toContain(WAITING_RULE);
    expect(testerPrompt(config, [])).toContain(WAITING_RULE);
  });

  it('tell the spec agent to settle what a new field holds when it does not apply, from the existing API', () => {
    expect(specifierPrompt([])).toMatch(/when it does not apply.*existing API.*0, not null/);
  });

  it('tell the implementer to keep existing callers working, and the reviewer to check it', () => {
    expect(implementerPrompt(config, [])).toMatch(/Keep existing callers working.*optional with a default/);
    expect(reviewerPrompt(config, [], 'main')).toMatch(/new required parameter, option, field or constructor argument/);
  });
});
