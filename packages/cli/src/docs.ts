// `factory docs`: the guides and reference that ship with this version of the factory, read at
// the terminal (or by an assistant helping someone use the factory). Topics and sections come
// from the files themselves, so there is no index to keep up to date.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function docsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');
}

export interface Section {
  heading: string;
  level: number;
  anchor: string;
  /** The section's text, its subsections included. */
  text: string;
}

export interface Topic {
  /** The file name without .md: `add-a-project`, `cli`. */
  name: string;
  /** From the docs folder: `guides/add-a-project.md`. */
  path: string;
  title: string;
  /** The first sentence after the title. */
  summary: string;
  sections: Section[];
  text: string;
}

const slug = (heading: string) =>
  heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

export function parseTopic(path: string, text: string): Topic {
  const lines = text.split('\n');
  const heads: Array<{ i: number; level: number; heading: string }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.+?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1]!.length, heading: m[2]! });
  });
  const title = heads.find((h) => h.level === 1)?.heading ?? path;
  const firstPara = lines.slice((heads[0]?.i ?? -1) + 1).join('\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('```'));
  const summary = (firstPara ?? '').replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').split(/(?<=\.)\s/)[0] ?? '';
  const sections = heads
    .filter((h) => h.level > 1)
    .map((h) => {
      const end = heads.find((n) => n.i > h.i && n.level <= h.level)?.i ?? lines.length;
      return { heading: h.heading.replace(/`/g, ''), level: h.level, anchor: slug(h.heading), text: lines.slice(h.i, end).join('\n').trim() };
    });
  return { name: path.split('/').pop()!.replace(/\.md$/, ''), path, title: title.replace(/`/g, ''), summary, sections, text };
}

/** Folders of docs/ that are for the project's maintainers, not for people using the factory. */
const MAINTAINER_DIRS = new Set(['maintainers']);

export function loadTopics(dir = docsDir()): Topic[] {
  const out: Topic[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) {
        if (!(at === dir && MAINTAINER_DIRS.has(e.name))) walk(join(at, e.name));
      }
      else if (e.name.endsWith('.md')) out.push(parseTopic(relative(dir, join(at, e.name)), readFileSync(join(at, e.name), 'utf8')));
    }
  };
  if (existsSync(dir)) walk(dir);
  // Start here first, then guides, reference, the rest.
  const rank = (t: Topic) => (t.path.includes('/') ? ['guides', 'reference'].indexOf(t.path.split('/')[0]!) + 1 || 3 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function findTopic(topics: Topic[], name: string): Topic | undefined {
  const n = name.toLowerCase().replace(/\.md$/, '');
  return topics.find((t) => t.name === n || t.path.replace(/\.md$/, '') === n) ?? topics.find((t) => t.name.includes(n) || t.title.toLowerCase().includes(n));
}

/** A section by anchor, heading, or words of the heading. */
export function findSection(topic: Topic, words: string): Section | undefined {
  const w = words.toLowerCase().trim();
  return (
    topic.sections.find((s) => s.anchor === slug(w) || s.heading.toLowerCase() === w) ??
    topic.sections.find((s) => w.split(/\s+/).every((x) => s.heading.toLowerCase().includes(x)))
  );
}

export interface Hit {
  topic: Topic;
  section?: Section;
  score: number;
}

/** Sections whose heading or text has the words, best first: heading matches count most. */
export function searchDocs(topics: Topic[], query: string, limit = 8): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const topic of topics) {
    // Only the smallest sections, so a hit points at the part that says it.
    const leaves = topic.sections.filter((s) => !topic.sections.some((o) => o !== s && o.level > s.level && s.text.includes(o.text)));
    for (const section of leaves.length ? leaves : topic.sections) {
      const text = section.text.toLowerCase();
      const head = section.heading.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      const score = words.reduce((a, w) => a + (head.includes(w) ? 5 : 0) + Math.min(5, text.split(w).length - 1), 0);
      hits.push({ topic, section, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function formatTopicList(topics: Topic[]): string {
  const width = Math.max(...topics.map((t) => t.name.length));
  const group = (t: Topic) => (t.path.startsWith('guides/') ? 'Guides' : t.path.startsWith('reference/') ? 'Reference' : t.path.includes('/') ? 'Design notes' : 'Start here');
  const out: string[] = [];
  let last = '';
  for (const t of topics) {
    if (group(t) !== last) out.push(`${out.length ? '\n' : ''}${(last = group(t))}:`);
    out.push(`  ${t.name.padEnd(width)}  ${t.title}`);
  }
  out.push('', 'factory docs <topic> prints one; factory docs <topic> <section> prints a section;', 'factory docs --search <words> finds the sections that mention them.');
  return `${out.join('\n')}\n`;
}

export function formatSections(t: Topic): string {
  return t.sections.map((s) => `${'  '.repeat(s.level - 2)}${s.heading}`).join('\n');
}
