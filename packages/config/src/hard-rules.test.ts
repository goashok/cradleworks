import { describe, expect, it } from 'vitest';
import { KNOWN_SECRET_PATTERNS } from './hard-rules.ts';

// Samples are assembled at run time from harmless pieces, so no file holds anything a
// secret scanner (ours or a host's) would take for a real token.
const r = (n: number, c = 'x') => c.repeat(n);
const SAMPLES: Record<string, string> = {
  'AWS access key': `AKIA${r(16, 'Q')}`,
  'GitHub token': `ghp_${r(36)}`,
  'GitLab token': `glpat-${r(20)}`,
  'Anthropic API key': `sk-ant-${r(40)}`,
  'OpenAI API key': `sk-proj-${r(48)}`,
  'Slack token': `xoxb-${r(12, '1')}`,
  'Google API key': `AIza${r(35)}`,
  'Stripe secret key': `sk_live_${r(24)}`,
  'npm token': `npm_${r(36)}`,
};

describe('known secret formats', () => {
  it('has a sample for every pattern, and each matches only its own', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(KNOWN_SECRET_PATTERNS.map((p) => p.kind).sort());
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      const hits = KNOWN_SECRET_PATTERNS.filter((p) => p.pattern.test(`token = "${sample}"`)).map((p) => p.kind);
      expect(hits, kind).toEqual([kind]);
    }
  });

  it('leaves ordinary code alone', () => {
    const code = ['const key = process.env.API_KEY;', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}', 'task-ask-for-review', 'AKIA is a prefix'];
    for (const line of code) expect(KNOWN_SECRET_PATTERNS.filter((p) => p.pattern.test(line)).map((p) => p.kind), line).toEqual([]);
  });
});
