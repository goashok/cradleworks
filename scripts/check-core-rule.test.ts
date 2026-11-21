import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCoreRule } from './check-core-rule.ts';

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'core-rule-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkCoreRule', () => {
  it('passes clean core code', () => {
    const dir = fixture({
      'index.ts': "import { x } from '@cradleworks/interfaces';\nimport { y } from './y.ts';\nimport { join } from 'node:path';\n",
    });
    expect(checkCoreRule(dir)).toEqual([]);
  });

  it('fails on a planted vendor name, in code or comments, any case', () => {
    const dir = fixture({
      'a.ts': 'const host = "GitHub";\n',
      'nested/b.ts': '// run this with claude\n',
    });
    const found = checkCoreRule(dir).map((v) => `${v.file}:${v.line}:${v.detail.toLowerCase()}`);
    expect(found).toContain('a.ts:1:github');
    expect(found).toContain('nested/b.ts:1:claude');
  });

  it('does not flag words that only contain a banned name', () => {
    const dir = fixture({ 'a.ts': 'const reaction = 1; const springboard = 2; const awsome = 3;\n' });
    expect(checkCoreRule(dir)).toEqual([]);
  });

  it('fails on imports of anything but interfaces, node built-ins and relative files', () => {
    const dir = fixture({
      'a.ts': "import { Octokit } from '@octokit/rest';\nconst m = await import('some-sdk');\n",
    });
    const kinds = checkCoreRule(dir).map((v) => `${v.kind}:${v.detail}`);
    expect(kinds).toEqual(['forbidden-import:@octokit/rest', 'forbidden-import:some-sdk']);
  });
});
