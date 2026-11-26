// A look at the sandbox image's Dockerfile for one mistake that is easy to make: copying the whole
// repository into the image. The factory mounts each task's own copy of the code at /workspace for
// every step, so code baked into the image is never what the agent works on; it only goes stale,
// and it makes the image change with every commit, so a built image can't be reused.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository is the `project` build context: `docker build --build-context project=. …`. */
const CONTEXT = 'project';

/** Sources that mean "everything in the repository". */
const WHOLE = new Set(['.', './', '*', './*', '/', '/*']);

export interface ImageCopy {
  file: string;
  line: number;
  instruction: string;
}

/** Instructions with their first line number, continuation lines joined. */
function instructions(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let current: { line: number; text: string } | undefined;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!current) {
      if (!line || line.startsWith('#')) return;
      current = { line: i + 1, text: '' };
    } else if (line.startsWith('#')) return;
    const more = line.endsWith('\\');
    current.text += `${current.text ? ' ' : ''}${more ? line.slice(0, -1).trim() : line}`;
    if (!more) {
      out.push(current);
      current = undefined;
    }
  });
  if (current) out.push(current);
  return out;
}

/** COPY or ADD instructions that copy the whole repository from the `project` context. */
export function wholeRepoCopies(file: string, text: string): ImageCopy[] {
  const found: ImageCopy[] = [];
  for (const ins of instructions(text)) {
    const m = /^(COPY|ADD)\s+(.*)$/i.exec(ins.text);
    if (!m) continue;
    const words = m[2]!.trim();
    const flags = [...words.matchAll(/--([\w-]+)(?:=(\S+))?/g)];
    if (!flags.some((f) => f[1]!.toLowerCase() === 'from' && f[2] === CONTEXT)) continue;
    const rest = words.replace(/--[\w-]+(?:=\S+)?\s*/g, '').trim();
    let paths: string[];
    if (rest.startsWith('[')) {
      try {
        paths = JSON.parse(rest) as string[];
      } catch {
        continue;
      }
    } else paths = rest.split(/\s+/);
    const sources = paths.slice(0, -1);
    if (sources.some((s) => WHOLE.has(s))) found.push({ file, line: ins.line, instruction: ins.text });
  }
  return found;
}

/** Notes for `factory validate` about `.factory/image/`'s Dockerfiles. */
export function checkImage(repoRoot: string): string[] {
  const dir = join(repoRoot, '.factory', 'image');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /dockerfile/i.test(f));
  return files.flatMap((f) =>
    wholeRepoCopies(`.factory/image/${f}`, readFileSync(join(dir, f), 'utf8')).map(
      (c) =>
        `${c.file}:${c.line} copies the whole repository into the image (${c.instruction}). The factory mounts each task's own copy of the code at /workspace for every step, so code in the image is never what the agent works on, and it makes the image change with every commit, so a built image can't be reused. Copy only what installs dependencies (for example package.json and package-lock.json), and let builds and tests run in /workspace.`,
    ),
  );
}
