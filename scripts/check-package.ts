// Installs the built package into an empty project, the way a user or a service would, and checks
// that it works from there: the `factory` command, its settings defaults and docs, the
// `cradleworks/hosting` and `cradleworks/testing` entry points and their types, and which version
// it says it is. The release workflow runs it before publishing.
//
//   node scripts/check-package.ts [dist/cradleworks-<version>.tgz]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tgz = resolve(process.argv[2] ?? join(root, 'dist', readdirSync(join(root, 'dist')).find((f) => f.endsWith('.tgz'))!));
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const dir = mkdtempSync(join(tmpdir(), 'cradleworks-package-'));
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
let failed = 0;
const check = (what: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok    ${what}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${what}\n      ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').slice(0, 6).join('\n      ')}`);
  }
};

writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
sh('npm', ['install', '--silent', '--no-audit', '--no-fund', tgz]);
const installed = join(dir, 'node_modules', 'cradleworks');

check('`factory help` runs', () => {
  if (!sh(join(dir, 'node_modules', '.bin', 'factory'), ['help']).includes('factory')) throw new Error('no help text');
});
check('`factory config explain` finds the defaults and docs', () => {
  const text = sh(join(dir, 'node_modules', '.bin', 'factory'), ['config', 'explain', 'budgets.per_task_usd']);
  if (!/per_task_usd/.test(text)) throw new Error(text.slice(0, 300));
});
check('no test library is installed with it', () => {
  if (readdirSync(join(dir, 'node_modules')).includes('vitest')) throw new Error('vitest came with the package');
});
writeFileSync(
  join(dir, 'use.ts'),
  `import { existsSync } from 'node:fs';
import * as h from 'cradleworks/hosting';
import * as t from 'cradleworks/testing';
const v: { version: string; commit?: string } = h.factoryVersion();
if (v.version !== ${JSON.stringify(version)} || !v.commit) throw new Error('version ' + JSON.stringify(v));
if (!existsSync(h.DEFAULTS_PATH)) throw new Error('no defaults at ' + h.DEFAULTS_PATH);
const needed = [h.run, h.commandFor, h.PostgresStateStore, h.WorkItemRepository, h.EventSpecStore, h.costByRun, h.headline, h.story, h.taskState, h.waitsForPerson, h.needsPerson, h.formatLog, h.parseProjectConfig, h.loadProjectConfig, h.formatIssue, h.explain, h.tokenProviderFromEnv, h.detectStack, h.renderFactoryYaml, h.renderDockerfile, h.loadSuite, h.loadTask, h.compare, h.yaml.parseDocument, t.createBareRepo, t.ScriptedAgentRuntime, t.FakeTracker];
if (needed.some((x) => typeof x !== 'function')) throw new Error('a hosting export is missing');
if (!h.FACTORY_YAML) throw new Error('no schema');
const cmd: string[] | undefined = h.commandFor({ action: 'approve', id: 'wi_1' });
console.log(JSON.stringify(v), cmd ? 'commandFor ok' : 'commandFor undefined');
`,
);
check('`cradleworks/hosting` and `cradleworks/testing` load, with this version', () => {
  console.log(`      ${sh('node', ['use.ts']).trim()}`);
});
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'es2024', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, typeRoots: [join(root, 'node_modules', '@types')], types: ['node'] }, include: ['use.ts'] }),
);
check('their types check in a strict TypeScript project', () => {
  sh(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json']);
});
check('build-info.json says where it came from', () => {
  const b = JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')) as { commit: string };
  if (!/^[0-9a-f]{40}$/.test(b.commit)) throw new Error(JSON.stringify(b));
});

console.log(failed ? `\n${failed} check${failed === 1 ? '' : 's'} failed (${dir})` : `\nthe package works (${tgz.split('/').pop()})`);
process.exit(failed ? 1 : 0);
