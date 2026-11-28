import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSection, findTopic, loadTopics, parseTopic, searchDocs } from './docs.ts';
import { run } from './index.ts';

const cli = async (args: string[], cwd = process.cwd()) => {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { cwd, env: {}, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
};

describe('factory docs', () => {
  it('reads topics and sections from the files, skipping headings in code blocks', () => {
    const t = parseTopic('guides/x.md', '# X guide\n\nFirst. Second.\n\n## One\n\ntext\n\n```sh\n# not a heading\n```\n\n### Deeper\n\nmore\n\n## Two\n\nend\n');
    expect(t).toMatchObject({ name: 'x', title: 'X guide', summary: 'First.' });
    expect(t.sections.map((s) => [s.heading, s.level])).toEqual([['One', 2], ['Deeper', 3], ['Two', 2]]);
    expect(findSection(t, 'one')!.text).toContain('more');
  });

  it('leaves out the maintainers\' pages', () => {
    const paths = loadTopics().map((t) => t.path);
    expect(paths).toContain('guides/evaluating.md');
    expect(paths.some((p) => p.startsWith('maintainers/'))).toBe(false);
  });

  it('finds the shipped guides and the section that answers a question', () => {
    const topics = loadTopics();
    expect(findTopic(topics, 'verify-and-approve')?.title).toBe('Verify, rework and approve');
    const [first] = searchDocs(topics, 'drill known-bad');
    expect(first?.topic.name).toBe('verify-and-approve');
  });

  it('prints a list, a section, and search hits', async () => {
    expect((await cli(['docs'])).stdout).toContain('add-a-project');
    const s = await cli(['docs', 'verify-and-approve', 'agent checks']);
    expect(s.stdout).toMatch(/^## Agent checks/);
    expect(s.stdout).toContain('(docs/guides/verify-and-approve.md#agent-checks)');
    expect((await cli(['docs', '--search', 'noise band'])).stdout).toContain('factory docs measuring');
    expect((await cli(['docs', 'nope-nothing'])).code).toBe(2);
  });
});

describe('factory validate --json', () => {
  it('gives problems and notes as data, and config errors with their lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-validate-'));
    try {
      mkdirSync(join(dir, '.factory', 'rules'), { recursive: true });
      writeFileSync(join(dir, '.factory', 'rules', 'style.md'), 'short\n');
      writeFileSync(join(dir, '.factory', 'factory.yaml'), 'project: demo\nadapters: { scm: local-git, ci: none, tracker: none, sandbox: process, runtime: cli-agent }\nruntime: { agent: claude-code, model: m }\nstack: { image: i, build: "true", test: "true" }\n');
      const ok = await cli(['validate', '--json'], dir);
      expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, project: 'demo', ruleFiles: 1, problems: [], notes: expect.arrayContaining([expect.stringContaining('no tracker')]) });
      writeFileSync(join(dir, '.factory', 'factory.yaml'), 'project: demo\ngates: { change_approval: maybe }\n');
      const bad = await cli(['validate', '--json'], dir);
      expect(bad.code).toBe(2);
      expect(JSON.parse(bad.stdout).configErrors).toEqual(expect.arrayContaining([expect.objectContaining({ line: 2, message: expect.stringContaining('change_approval') })]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
