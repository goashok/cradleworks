// Builds the factory into one installable package, dist/cradleworks-<version>.tgz: JavaScript and
// type declarations in the same folders as the sources (so defaults/ and docs/ are found next to
// the code, as in a checkout), the `factory` command, and the entry points `cradleworks/hosting` and
// `cradleworks/testing`. The release workflow attaches it to a GitHub release; see
// docs/guides/releasing.md.
//
//   node scripts/build-package.ts            # then: node scripts/check-package.ts

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(dist, 'package');
const sh = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; description: string; license: string; engines: Record<string, string> };
const version = rootPkg.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`package.json has no usable version: ${version}`);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

// 1. Compile.
if (existsSync(dist)) rmSync(dist, { recursive: true });
sh('npx', ['tsc', '-p', 'tsconfig.build.json']);

// 2. Files the code reads next to itself: non-TypeScript files in the sources, and the folders a
//    checkout has at its root.
const packages = readdirSync(join(root, 'packages')).filter((p) => existsSync(join(root, 'packages', p, 'package.json')));
for (const p of packages) {
  for (const f of files(join(root, 'packages', p, 'src'))) {
    if (f.endsWith('.ts') || f.split(sep).includes('fixtures')) continue;
    const to = join(out, relative(root, f));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(f, to);
  }
}
for (const d of ['defaults', 'docs', 'skills', 'LICENSE', 'README.md']) cpSync(join(root, d), join(out, d), { recursive: true });

// 3. The packages reach each other by name (`@cradleworks/core`) inside the workspace; in the
//    package they are folders, so each name becomes a relative path. `.ts` left in declarations
//    becomes `.js`.
const entries = new Map<string, string>();
const outside: Record<string, string> = {};
for (const p of packages) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', p, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string>; dependencies?: Record<string, string> };
  for (const [sub, target] of Object.entries(pkg.exports)) entries.set(sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`, join(out, 'packages', p, target.replace(/\.ts$/, '.js')));
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith('@cradleworks/') || dep === 'vitest') continue;
    if (outside[dep] && outside[dep] !== range) throw new Error(`${dep} is wanted at both ${outside[dep]} and ${range}`);
    outside[dep] = range;
  }
}
const SPEC = /((?:from|import)\s*\(?\s*)(['"])(@cradleworks\/[a-z-]+(?:\/[a-z-]+)?|\.{1,2}\/[^'"]+?\.ts)\2/g;
for (const f of files(join(out, 'packages')).filter((x) => x.endsWith('.js') || x.endsWith('.d.ts'))) {
  const text = readFileSync(f, 'utf8');
  const next = text.replace(SPEC, (_m, lead: string, q: string, spec: string) => {
    if (spec.startsWith('.')) return `${lead}${q}${spec.replace(/\.ts$/, '.js')}${q}`;
    const target = entries.get(spec);
    if (!target) throw new Error(`${relative(out, f)} imports ${spec}, which no package exports`);
    let rel = relative(dirname(f), target).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${q}${rel}${q}`;
  });
  if (/['"]@cradleworks\//.test(next)) throw new Error(`${relative(out, f)} still names a workspace package`);
  if (next !== text) writeFileSync(f, next);
}

// 4. The package itself.
const commit = sh('git', ['rev-parse', 'HEAD']);
const dirty = sh('git', ['status', '--porcelain']) !== '';
const at = (p: string) => `./${relative(out, entries.get(p)!).split(sep).join('/')}`;
const types = (js: string) => js.replace(/\.js$/, '.d.ts');
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'cradleworks',
      version,
      description: rootPkg.description,
      license: rootPkg.license,
      repository: { type: 'git', url: 'git+https://github.com/goashok/cradleworks.git' },
      type: 'module',
      engines: rootPkg.engines,
      bin: { factory: './packages/cli/src/main.js' },
      exports: {
        './hosting': { types: './packages/cli/src/hosting.d.ts', default: './packages/cli/src/hosting.js' },
        './testing': { types: types(at('@cradleworks/contracts/fakes')), default: at('@cradleworks/contracts/fakes') },
        './package.json': './package.json',
      },
      dependencies: Object.fromEntries(Object.entries(outside).sort()),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(join(out, 'build-info.json'), JSON.stringify({ version, commit, ...(dirty ? { dirty: true } : {}), builtAt: new Date().toISOString() }, null, 2) + '\n');
chmodSync(join(out, 'packages', 'cli', 'src', 'main.js'), 0o755);

// 5. Pack.
const tgz = sh('npm', ['pack', '--silent', '--pack-destination', dist], out).split('\n').pop()!;
const size = statSync(join(dist, tgz)).size;
console.log(`built dist/${tgz} (${(size / 1024).toFixed(0)} KB) from ${commit.slice(0, 12)}${dirty ? ' with uncommitted changes' : ''}`);
