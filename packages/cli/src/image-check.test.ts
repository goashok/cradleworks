import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkImage, wholeRepoCopies } from './image-check.ts';

describe('the image check', () => {
  it('finds a copy of the whole repository from the project context, in any of its spellings', () => {
    const text = [
      'FROM node:22',
      'COPY --from=project package.json package-lock.json /tmp/deps/',
      'COPY --from=project . /app',
      'COPY --chown=node --from=project ./ /app',
      'ADD --from=project \\',
      '    * /app/',
      'COPY --from=project ["." , "/srv"]',
      'COPY . /image-files',
      'COPY --from=builder . /app',
      '# COPY --from=project . /commented',
    ].join('\n');
    expect(wholeRepoCopies('Dockerfile', text).map((c) => c.line)).toEqual([3, 4, 5, 7]);
  });

  it('leaves a Dockerfile that copies only what installs dependencies alone', () => {
    expect(wholeRepoCopies('Dockerfile', 'FROM node:22\nCOPY --from=project package.json package-lock.json /tmp/deps/\nRUN npm ci\nWORKDIR /workspace\n')).toEqual([]);
  });

  it('gives factory validate one note per copy, with the file, line and what to do instead', () => {
    const root = mkdtempSync(join(tmpdir(), 'image-check-'));
    expect(checkImage(root)).toEqual([]);
    mkdirSync(join(root, '.factory', 'image'), { recursive: true });
    writeFileSync(join(root, '.factory', 'image', 'Dockerfile'), 'FROM node:22\nCOPY --from=project . /app\n');
    const [note] = checkImage(root);
    expect(note).toMatch(/^\.factory\/image\/Dockerfile:2 copies the whole repository into the image/);
    expect(note).toContain('mounts each task');
    expect(note).toContain('/workspace');
    expect(note).toContain('package-lock.json');
  });
});
