// Runs where a Docker engine answers (developer machines and CI); skipped elsewhere.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSandboxContract, expectAdapterError } from '@cradleworks/contracts';
import { createBareRepo, LocalGitSourceControl, localRepoRef } from '@cradleworks/contracts/fakes';
import type { SandboxHandle, SandboxSpec } from '@cradleworks/interfaces';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_IMAGE, DockerSandbox, findDocker, SANDBOX_LABEL } from './index.ts';

const IMAGE = 'alpine:3.20';
const docker = findDocker();
const haveDocker = await DockerSandbox.available(docker);
const dockerOut = (args: string[]) => execFileSync(docker, args, { encoding: 'utf8' }).trim();

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cw-docker-'));
  const bare = join(root, 'remote.git');
  await createBareRepo(bare, { 'README.md': '# Fixture\n' });
  const source = await new LocalGitSourceControl().clone(localRepoRef(bare), join(root, 'source'));
  return { root, source };
}

if (haveDocker) for (const image of [IMAGE, DEFAULT_PROXY_IMAGE]) execFileSync(docker, ['pull', '--quiet', image], { stdio: 'ignore' });

describe.skipIf(!haveDocker)('DockerSandbox', () => {
  describeSandboxContract(
    'local docker',
    async () => {
      const { root, source } = await fixture();
      return {
        adapter: new DockerSandbox({ rootDir: join(root, 'sandboxes'), docker }),
        source,
        baseRef: 'main',
        image: IMAGE,
        cleanup: async () => rmSync(root, { recursive: true, force: true }),
      };
    },
    { timeoutMs: 60_000 },
  );

  describe('isolation', { timeout: 60_000 }, () => {
    let root: string;
    let adapter: DockerSandbox;
    let base: Omit<SandboxSpec, 'taskId' | 'branch'>;
    const open: SandboxHandle[] = [];
    let n = 0;

    beforeAll(async () => {
      const f = await fixture();
      root = f.root;
      adapter = new DockerSandbox({ rootDir: join(root, 'sandboxes'), docker });
      base = { source: f.source, baseRef: 'main', image: IMAGE, network: { mode: 'none', allow: [] } };
    });
    afterEach(async () => {
      for (const s of open.splice(0)) await adapter.destroy(s);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const create = async (overrides: Partial<SandboxSpec> = {}) => {
      const taskId = `iso-${Date.now().toString(36)}-${++n}`;
      const s = await adapter.create({ ...base, taskId, branch: `factory/${taskId}`, ...overrides });
      open.push(s);
      return s;
    };
    const sh = (s: SandboxHandle, script: string) => adapter.exec(s, ['sh', '-c', script]);

    it('has no network with mode none', async () => {
      const s = await create();
      const r = await sh(s, 'wget -q -T 3 -O - http://1.1.1.1 >/dev/null 2>&1; echo "exit=$?"; wc -l < /proc/net/route');
      const [exit, routes] = r.stdout.trim().split('\n');
      expect(exit).toMatch(/exit=[1-9]/);
      expect(routes?.trim()).toBe('1'); // the header line only: no route anywhere
    });

    it('lets only allowed hosts through the egress proxy, and logs each decision', async () => {
      const s = await create({ network: { mode: 'allowlist', allow: ['example.com', '*.example.org:443'] } });
      const r = await sh(
        s,
        [
          // allowed, plain HTTP through the proxy
          'wget -q -T 10 -O /dev/null http://example.com/ && echo http-allowed',
          // not listed
          'wget -q -T 10 -O /dev/null http://neverssl.com/ 2>/dev/null || echo http-denied',
          // HTTPS goes through CONNECT; a subdomain rule on port 443
          `printf 'CONNECT www.example.org:443 HTTP/1.1\\r\\n\\r\\n' | timeout 10 nc egress-proxy 3128 | head -1`,
          `printf 'CONNECT example.org:443 HTTP/1.1\\r\\n\\r\\n' | timeout 10 nc egress-proxy 3128 | head -1`,
          // an allowed name still cannot reach an internal address
          `printf 'CONNECT host.docker.internal:443 HTTP/1.1\\r\\n\\r\\n' | timeout 10 nc egress-proxy 3128 | head -1`,
          // no way around the proxy
          'env -u http_proxy -u HTTP_PROXY wget -q -T 3 -O /dev/null http://example.com/ 2>/dev/null || echo direct-blocked',
        ].join('; '),
      );
      const lines = r.stdout.trim().split('\n').map((l) => l.trim());
      expect(lines[0]).toBe('http-allowed');
      expect(lines[1]).toBe('http-denied');
      expect(lines[2]).toMatch(/^HTTP\/1\.1 200/);
      expect(lines[3]).toMatch(/^HTTP\/1\.1 403/); // *.example.org does not cover example.org itself
      expect(lines[4]).toMatch(/^HTTP\/1\.1 403/);
      expect(lines[5]).toBe('direct-blocked');

      const log = await adapter.egressLog(s);
      expect(log.map((d) => [d.host, d.decision])).toEqual(
        expect.arrayContaining([
          ['example.com', 'allow'],
          ['neverssl.com', 'deny'],
          ['www.example.org', 'allow'],
          ['example.org', 'deny'],
        ]),
      );
    });

    it('applies a policy change at once, and can switch between none and an allow-list', async () => {
      const s = await create();
      const get = async () => (await sh(s, 'wget -q -T 10 -O /dev/null http://example.com/ 2>/dev/null && echo ok || echo no')).stdout.trim();
      expect(await get()).toBe('no');
      await adapter.setNetworkPolicy(s, { mode: 'allowlist', allow: ['example.com'] });
      expect(await get()).toBe('ok');
      await adapter.setNetworkPolicy(s, { mode: 'allowlist', allow: ['example.net'] });
      expect(await get()).toBe('no');
      await adapter.setNetworkPolicy(s, { mode: 'none', allow: [] });
      expect(await get()).toBe('no');
      expect(dockerOut(['ps', '--all', '--quiet', '--filter', `name=^${adapter.containerOf(s)}-egress$`])).toBe('');
    });

    it('refuses a malformed allow-list entry', async () => {
      await expectAdapterError(create({ network: { mode: 'allowlist', allow: ['https://example.com/path'] } }), 'invalid_input');
    });

    it('cannot change git\'s own files, so nothing it plants runs on the host', async () => {
      const s = await create();
      const gitDir = execFileSync('git', ['-C', s.workspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
      const r = await sh(
        s,
        [
          'echo "gitdir: /tmp/evil" > .git 2>/dev/null && echo replaced-link',
          'rm -f .git 2>/dev/null && echo removed-link',
          `echo 'touch /tmp/pwned' > '${gitDir}/hooks/pre-commit' 2>/dev/null && echo wrote-hook`,
          `printf '[core]\\n\\tfsmonitor = touch /tmp/pwned\\n' >> '${gitDir}/config' 2>/dev/null && echo wrote-config`,
          'echo done',
        ].join('; '),
      );
      expect(r.stdout.trim()).toBe('done');
      expect(readFileSync(join(s.workspacePath, '.git'), 'utf8')).toMatch(/^gitdir: /);
      expect(existsSync(join(gitDir, 'hooks', 'pre-commit'))).toBe(false);
      expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toContain('fsmonitor');
    });

    it('runs as the host user with no capabilities', async () => {
      const s = await create();
      const r = await sh(s, 'id -u; grep CapEff /proc/self/status; touch owned.txt');
      const [uid, caps] = r.stdout.trim().split('\n');
      if (process.getuid) expect(uid).toBe(String(process.getuid()));
      expect(caps).toMatch(/CapEff:\s+0+$/);
      if (process.getuid) expect(execFileSync('stat', process.platform === 'darwin' ? ['-f', '%u', join(s.workspacePath, 'owned.txt')] : ['-c', '%u', join(s.workspacePath, 'owned.txt')], { encoding: 'utf8' }).trim()).toBe(String(process.getuid()));
    });

    it('resolves copy paths inside the container, so a planted symlink cannot reach the host', async () => {
      const s = await create();
      const outside = join(root, 'host-secret.txt');
      writeFileSync(outside, 'secret');
      await sh(s, `ln -s '${outside}' link.txt`);
      const dir = mkdtempSync(join(tmpdir(), 'cw-copy-'));
      try {
        writeFileSync(join(dir, 'in.txt'), 'overwrite');
        await adapter.copyIn(s, join(dir, 'in.txt'), 'link.txt').catch(() => undefined);
        expect(readFileSync(outside, 'utf8')).toBe('secret');
        await expectAdapterError(adapter.copyIn(s, join(dir, 'in.txt'), '.git/hooks/pre-commit'), 'invalid_input');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps run-scoped variables out of the container config', async () => {
      const s = await create({ env: { REPO_TOKEN: 'tok-123' } });
      expect((await sh(s, 'echo "$REPO_TOKEN"')).stdout).toBe('tok-123\n');
      expect(dockerOut(['inspect', '--format', '{{json .Config.Env}}', adapter.containerOf(s)!])).not.toContain('tok-123');
    });

    it('kills the whole process tree on timeout', async () => {
      const s = await create();
      const r = await adapter.exec(s, ['sh', '-c', 'sh -c "sleep 30" & sleep 30'], { timeoutSeconds: 1 });
      expect(r.timedOut).toBe(true);
      const left = await sh(s, 'ps -o args | grep -c "[s]leep 30"');
      expect(left.stdout.trim()).toBe('0');
    });

    it('leaves no worktree or container after destroy', async () => {
      const s = await create({ network: { mode: 'allowlist', allow: ['example.com'] } });
      const container = adapter.containerOf(s)!;
      await adapter.destroy(s);
      open.length = 0;
      expect(existsSync(s.workspacePath)).toBe(false);
      expect(dockerOut(['ps', '--all', '--quiet', '--filter', `name=^${container}$`])).toBe('');
      expect(dockerOut(['ps', '--all', '--quiet', '--filter', `name=^${container}-egress$`])).toBe('');
      expect(dockerOut(['network', 'ls', '--quiet', '--filter', `name=^${container}-net$`])).toBe('');
      expect(execFileSync('git', ['-C', base.source.path, 'worktree', 'list'], { encoding: 'utf8' })).not.toContain(s.taskId);
    });

    it('removes orphaned containers left by a dead factory process', async () => {
      const s = await create();
      const container = adapter.containerOf(s)!;
      const fresh = new DockerSandbox({ rootDir: join(root, 'sandboxes'), docker });
      expect(await fresh.pruneOrphans()).toContain(container);
      expect(dockerOut(['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=${s.taskId}`])).toBe('');
    });
  });
});
