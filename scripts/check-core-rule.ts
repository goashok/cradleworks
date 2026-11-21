// Enforces the Build spec's core rule: nothing in the core may name a vendor,
// stack or project, and the core may import only the interfaces package,
// Node built-ins and its own files.
//
// Usage: node scripts/check-core-rule.ts [coreSrcDir]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BANNED_NAMES: readonly string[] = [
  // source control, CI, trackers
  'github', 'gitlab', 'bitbucket', 'jenkins', 'jira', 'azure',
  // agents and model providers
  'claude', 'anthropic', 'openai', 'codex', 'bedrock', 'gemini',
  // execution environments
  'docker', 'kubernetes', 'k8s', 'aws', 'fargate', 'ecs',
  // stores
  'sqlite', 'postgres', 'postgresql',
  // reference stacks and projects
  'spring', 'react', 'maven', 'flyway', 'orders-service', 'notifications-service',
];

export const ALLOWED_PACKAGES: readonly string[] = ['@cradleworks/interfaces'];

export interface Violation {
  file: string;
  line: number;
  kind: 'banned-name' | 'forbidden-import';
  detail: string;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md'];
const IMPORT_PATTERN = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

function isAllowedImport(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  if (specifier.startsWith('node:')) return true;
  return ALLOWED_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

export function checkCoreRule(coreDir: string): Violation[] {
  const violations: Violation[] = [];
  const banned = new RegExp(`(?<![a-z0-9])(${BANNED_NAMES.map(escape).join('|')})(?![a-z0-9])`, 'gi');

  for (const file of listFiles(coreDir)) {
    const rel = relative(coreDir, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(banned)) {
        violations.push({ file: rel, line: index + 1, kind: 'banned-name', detail: match[1] ?? match[0] });
      }
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier !== undefined && !isAllowedImport(specifier)) {
          violations.push({ file: rel, line: index + 1, kind: 'forbidden-import', detail: specifier });
        }
      }
    });
  }
  return violations;
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
  const coreDir = process.argv[2] ?? join(repoRoot, 'packages', 'core', 'src');
  const violations = checkCoreRule(coreDir);
  if (violations.length === 0) {
    console.log(`core rule: OK (${coreDir})`);
    return;
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}  ${v.kind}  ${v.detail}`);
  }
  console.error(`core rule: ${violations.length} violation(s). The core must not name vendors, stacks or projects.`);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
