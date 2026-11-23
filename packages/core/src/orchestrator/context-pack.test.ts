import { describe, expect, it } from 'vitest';
import { buildContextPack, matchRules, sha256, withAddition } from './context-pack.ts';

const rules = [
  { path: '.factory/rules/a.md', content: 'aaaa' },
  { path: '.factory/rules/b.md', content: 'bbbbbbbb' },
];

describe('context pack', () => {
  it('matches rule patterns against the base tree in pattern order, each file once', () => {
    const tree = ['README.md', '.factory/rules/b.md', '.factory/rules/a.md', 'docs/x.md', 'AGENTS.md'];
    expect(matchRules(tree, ['AGENTS.md', '.factory/rules/*.md', '**/*.md'])).toEqual(['AGENTS.md', '.factory/rules/a.md', '.factory/rules/b.md', 'README.md', 'docs/x.md']);
    expect(matchRules(tree, ['nothing/*.md'])).toEqual([]);
  });

  it('lists rules with their size and hash, in order', () => {
    const pack = buildContextPack(rules);
    expect(pack.files).toEqual([
      { path: '.factory/rules/a.md', bytes: 4, sha256: sha256('aaaa'), kind: 'rule' },
      { path: '.factory/rules/b.md', bytes: 8, sha256: sha256('bbbbbbbb'), kind: 'rule' },
    ]);
    expect(pack.rules).toEqual(rules);
    expect(pack.addition).toBeUndefined();
  });

  it('puts the prompt addition first, in the same budget, and drops what no longer fits', () => {
    const addition = { path: '.factory/prompts/reviewer.md', text: 'cccccc' };
    const pack = buildContextPack(rules, 12, addition);
    expect(pack.files.map((f) => [f.path, f.kind])).toEqual([
      ['.factory/prompts/reviewer.md', 'prompt'],
      ['.factory/rules/a.md', 'rule'],
    ]);
    expect(pack.dropped).toEqual(['.factory/rules/b.md']);
    expect(pack.rules.map((r) => r.path)).toEqual(['.factory/rules/a.md']);
    expect(pack.addition).toEqual(addition);
    expect(buildContextPack([], 3, addition)).toMatchObject({ files: [], dropped: ['.factory/prompts/reviewer.md'] });
  });

  it('adds the addition after the role prompt, saying where it came from and that the role prompt wins', () => {
    expect(withAddition('Role.', undefined)).toBe('Role.');
    const out = withAddition('Role.', { path: '.factory/prompts/tester.md', text: 'Use fixtures.\n' });
    expect(out.startsWith('Role.\n\n')).toBe(true);
    expect(out).toContain('.factory/prompts/tester.md');
    expect(out).toContain('unless they conflict with the instructions above');
    expect(out.endsWith('Use fixtures.')).toBe(true);
  });
});
