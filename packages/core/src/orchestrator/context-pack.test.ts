import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack, sha256, withAddition } from './context-pack.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-pack-'));
  mkdirSync(join(dir, '.factory/rules'), { recursive: true });
  writeFileSync(join(dir, '.factory/rules/a.md'), 'aaaa');
  writeFileSync(join(dir, '.factory/rules/b.md'), 'bbbbbbbb');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('context pack', () => {
  it('lists rules with their size and hash, in order', () => {
    const pack = buildContextPack(dir, ['.factory/rules/*.md']);
    expect(pack.files).toEqual([
      { path: '.factory/rules/a.md', bytes: 4, sha256: sha256('aaaa'), kind: 'rule' },
      { path: '.factory/rules/b.md', bytes: 8, sha256: sha256('bbbbbbbb'), kind: 'rule' },
    ]);
    expect(pack.addition).toBeUndefined();
  });

  it('puts the prompt addition first, in the same budget, and drops what no longer fits', () => {
    const addition = { path: '.factory/prompts/reviewer.md', text: 'cccccc' };
    const pack = buildContextPack(dir, ['.factory/rules/*.md'], 12, addition);
    expect(pack.files.map((f) => [f.path, f.kind])).toEqual([
      ['.factory/prompts/reviewer.md', 'prompt'],
      ['.factory/rules/a.md', 'rule'],
    ]);
    expect(pack.dropped).toEqual(['.factory/rules/b.md']);
    expect(pack.addition).toEqual(addition);
    expect(buildContextPack(dir, [], 3, addition)).toMatchObject({ files: [], dropped: ['.factory/prompts/reviewer.md'] });
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
