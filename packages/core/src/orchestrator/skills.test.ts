import { describe, expect, it } from 'vitest';
import { formatLock, parseLock, parseSkill, skillHash, skillsOpened, skillsPrompt } from './skills.ts';

describe('skills', () => {
  it('reads SKILL.md front matter, and refuses one without a name and description', () => {
    expect(parseSkill('---\nname: pdf\ndescription: "Fill PDF forms"\nlicense: MIT\n---\n# PDF\n\nSteps.\n')).toEqual({ name: 'pdf', description: 'Fill PDF forms', body: '# PDF\n\nSteps.' });
    expect(parseSkill('# No front matter')).toBeUndefined();
    expect(parseSkill('---\nname: x\n---\nbody')).toBeUndefined();
  });

  it('hashes a folder by its paths and contents, whatever the order', () => {
    const a = [{ path: 'SKILL.md', content: 'x' }, { path: 'b/c.md', content: 'y' }];
    expect(skillHash(a)).toBe(skillHash([...a].reverse()));
    expect(skillHash(a)).not.toBe(skillHash([{ path: 'SKILL.md', content: 'x!' }, a[1]!]));
    expect(skillHash(a)).not.toBe(skillHash([{ path: 'SKILL.md', content: 'x' }, { path: 'b/d.md', content: 'y' }]));
  });

  it('reads and writes the lock, sorted, and treats a broken one as empty', () => {
    const lock = { zeta: { source: 'local', hash: 'h1' }, alpha: { source: 'https://x/y.git', path: 'a', ref: 'v1', commit: 'abc', hash: 'h2' } };
    const text = formatLock(lock);
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
    expect(parseLock(text)).toEqual(lock);
    expect(parseLock('{ nope')).toEqual({});
    expect(parseLock(undefined)).toEqual({});
  });

  it('offers on-demand skills by line and puts always skills in whole', () => {
    const text = skillsPrompt([
      { name: 'pdf', description: 'Fill PDF forms', load: 'on-demand', readAt: '/factory/skills/pdf', body: 'secret steps' },
      { name: 'style', description: 'House style', load: 'always', readAt: '/factory/skills/style', body: 'Small functions.' },
    ]);
    expect(text).toContain('- pdf: Fill PDF forms (/factory/skills/pdf/SKILL.md)');
    expect(text).not.toContain('secret steps');
    expect(text).toContain('Small functions.');
    expect(skillsPrompt([])).toBe('');
  });

  it('tells which offered skills a run opened, from its tool inputs', () => {
    const inputs = [{ file_path: '/factory/skills/pdf/SKILL.md' }, { command: 'cat /factory/skills/style/notes.md' }, 'ls /tmp'];
    expect(skillsOpened(inputs, '/factory/skills', ['pdf', 'style', 'unused'])).toEqual(['pdf', 'style']);
  });
});
