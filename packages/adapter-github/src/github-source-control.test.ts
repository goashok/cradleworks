// Unit tests with a fake fetch: request shapes and error mapping, no network.

import { AdapterError } from '@cradleworks/interfaces';
import { expectAdapterError } from '@cradleworks/contracts';
import { describe, expect, it } from 'vitest';
import { GitHubSourceControl } from './index.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeGitHub(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const path = url.replace('https://api.github.com', '').split('?')[0]!;
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as typeof fetch;
  const scm = new GitHubSourceControl({ token: async () => 'tok_test', fetch: fetchFake });
  return { scm, calls };
}

const pr = { id: 'acme/shop#7', url: 'https://github.com/acme/shop/pull/7' };

describe('openPR', () => {
  it('posts the pull request and labels, and returns owner/name#number', async () => {
    const { scm, calls } = fakeGitHub({
      'POST /repos/acme/shop/pulls': { status: 201, body: { number: 7, html_url: pr.url } },
      'POST /repos/acme/shop/issues/7/labels': { body: [] },
    });
    const ref = await scm.openPR({ repo: { id: 'acme/shop', url: '' }, head: 'factory/t1', base: 'main', title: 'T', body: 'B', labels: ['factory'] });
    expect(ref).toEqual(pr);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { title: 'T', head: 'factory/t1', base: 'main', body: 'B', draft: false } });
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok_test');
    expect(calls[1]).toMatchObject({ body: { labels: ['factory'] } });
  });

  it('maps "already exists" to conflict and other 422s to invalid_input', async () => {
    const exists = fakeGitHub({
      'POST /repos/acme/shop/pulls': { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:b.' }] } },
    });
    await expectAdapterError(exists.scm.openPR({ repo: { id: 'acme/shop', url: '' }, head: 'b', base: 'main', title: 't', body: '' }), 'conflict');
    const bad = fakeGitHub({ 'POST /repos/acme/shop/pulls': { status: 422, body: { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] } } });
    const error = await expectAdapterError(bad.scm.openPR({ repo: { id: 'acme/shop', url: '' }, head: 'nope', base: 'main', title: 't', body: '' }), 'invalid_input');
    expect(error.message).toMatch(/head invalid/);
  });

  it('refuses a malformed repository id before calling out', async () => {
    const { scm, calls } = fakeGitHub({});
    await expectAdapterError(scm.openPR({ repo: { id: 'not-a-repo', url: '' }, head: 'b', base: 'main', title: 't', body: '' }), 'invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('getPRStatus', () => {
  const routes = (pull: object, runs: object[] = [], statuses: object[] = [], reviews: object[] = []) => ({
    'GET /repos/acme/shop/pulls/7': { body: { html_url: pr.url, state: 'open', merged_at: null, mergeable: true, head: { sha: 'abc', ref: 'b' }, base: { ref: 'main' }, ...pull } },
    'GET /repos/acme/shop/pulls/7/reviews': { body: reviews },
    'GET /repos/acme/shop/commits/abc/check-runs': { body: { check_runs: runs } },
    'GET /repos/acme/shop/commits/abc/status': { body: { statuses } },
  });

  it('maps state, mergeability, checks and reviews', async () => {
    const { scm } = fakeGitHub(
      routes(
        { mergeable: null },
        [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }],
        [],
        [
          { user: { login: 'sam' }, state: 'CHANGES_REQUESTED', body: 'rename it', submitted_at: '2026-11-21T10:00:00Z' },
          { user: { login: 'sam' }, state: 'PENDING', body: '', submitted_at: null },
          { user: { login: 'kim' }, state: 'APPROVED', body: '', submitted_at: '2026-11-21T11:00:00Z' },
        ],
      ),
    );
    const status = await scm.getPRStatus(pr);
    expect(status).toMatchObject({ state: 'open', headSha: 'abc', baseBranch: 'main', mergeable: 'unknown', checks: 'pending' });
    expect(status.reviews.map((r) => [r.author.handle, r.verdict])).toEqual([
      ['sam', 'changes_requested'],
      ['kim', 'approved'],
    ]);
  });

  it('reports failing when any check or status fails, merged when merged', async () => {
    const failing = fakeGitHub(routes({}, [{ status: 'completed', conclusion: 'success' }], [{ state: 'failure' }]));
    expect((await failing.scm.getPRStatus(pr)).checks).toBe('failing');
    const merged = fakeGitHub(routes({ state: 'closed', merged_at: '2026-11-21T12:00:00Z' }));
    expect(await merged.scm.getPRStatus(pr)).toMatchObject({ state: 'merged', mergeable: false, checks: 'none' });
  });

  it('reads the rest when the token may not read checks or statuses, as with a fine-grained token', async () => {
    const forbidden = { status: 403, body: { message: 'Resource not accessible by personal access token' } };
    const neither = fakeGitHub({ ...routes({ state: 'closed', merged_at: '2026-11-21T12:00:00Z' }), 'GET /repos/acme/shop/commits/abc/check-runs': forbidden, 'GET /repos/acme/shop/commits/abc/status': forbidden });
    expect(await neither.scm.getPRStatus(pr)).toMatchObject({ state: 'merged', checks: 'unknown' });
    // What it can read still counts: a failing status is failing, a passing one alone isn't proof.
    const statusOnly = (state: string) => fakeGitHub({ ...routes({}, [], [{ state }]), 'GET /repos/acme/shop/commits/abc/check-runs': forbidden });
    expect((await statusOnly('failure').scm.getPRStatus(pr)).checks).toBe('failing');
    expect((await statusOnly('success').scm.getPRStatus(pr)).checks).toBe('unknown');
    // Other errors still fail the read.
    const broken = fakeGitHub({ ...routes({}), 'GET /repos/acme/shop/commits/abc/status': { status: 500, body: { message: 'boom' } } });
    await expect(broken.scm.getPRStatus(pr)).rejects.toThrow();
  });

  it('maps 404 to not_found', async () => {
    await expectAdapterError(fakeGitHub({}).scm.getPRStatus(pr), 'not_found');
  });
});

describe('merge', () => {
  it('sends the expected head sha and maps a moved head to conflict', async () => {
    const open = { 'GET /repos/acme/shop/pulls/7': { body: { state: 'open', merged_at: null } } };
    const ok = fakeGitHub({ ...open, 'PUT /repos/acme/shop/pulls/7/merge': { body: { sha: 'def', merged: true } } });
    expect((await ok.scm.merge(pr, { method: 'squash', expectedHeadSha: 'abc' })).sha).toBe('def');
    expect(ok.calls[1]!.body).toEqual({ merge_method: 'squash', sha: 'abc' });

    const moved = fakeGitHub({ ...open, 'PUT /repos/acme/shop/pulls/7/merge': { status: 409, body: { message: 'Head branch was modified.' } } });
    await expectAdapterError(moved.scm.merge(pr, { method: 'squash', expectedHeadSha: 'old' }), 'conflict');
    const unmergeable = fakeGitHub({ ...open, 'PUT /repos/acme/shop/pulls/7/merge': { status: 405, body: { message: 'Pull Request is not mergeable' } } });
    await expectAdapterError(unmergeable.scm.merge(pr, { method: 'merge', expectedHeadSha: 'abc' }), 'conflict');
  });

  it('maps a change that conflicts with the base to merge_conflict, and other refusals to conflict', async () => {
    const pull = (extra: object) => ({ 'GET /repos/acme/shop/pulls/7': { body: { state: 'open', merged_at: null, base: { ref: 'main' }, ...extra } } });
    const said = fakeGitHub({ ...pull({}), 'PUT /repos/acme/shop/pulls/7/merge': { status: 405, body: { message: 'Pull Request has merge conflicts' } } });
    await expectAdapterError(said.scm.merge(pr, { method: 'squash', expectedHeadSha: 'abc' }), 'merge_conflict');
    const dirty = fakeGitHub({ ...pull({ mergeable_state: 'dirty' }), 'PUT /repos/acme/shop/pulls/7/merge': { status: 405, body: { message: 'Pull Request is not mergeable' } } });
    await expectAdapterError(dirty.scm.merge(pr, { method: 'squash', expectedHeadSha: 'abc' }), 'merge_conflict');
    const blocked = fakeGitHub({ ...pull({ mergeable_state: 'blocked' }), 'PUT /repos/acme/shop/pulls/7/merge': { status: 405, body: { message: 'At least 1 approving review is required' } } });
    await expectAdapterError(blocked.scm.merge(pr, { method: 'squash', expectedHeadSha: 'abc' }), 'conflict');
  });

  it('refuses to merge a pull request that is already merged, without calling merge', async () => {
    const { scm, calls } = fakeGitHub({ 'GET /repos/acme/shop/pulls/7': { body: { state: 'closed', merged_at: '2026-11-21T12:00:00Z' } } });
    await expectAdapterError(scm.merge(pr, { method: 'squash', expectedHeadSha: 'abc' }), 'conflict');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('errors', () => {
  it('maps auth, rate limits and outages', async () => {
    const path = 'POST /repos/acme/shop/issues/7/comments';
    await expectAdapterError(fakeGitHub({ [path]: { status: 401, body: { message: 'Bad credentials' } } }).scm.comment(pr, 'x'), 'unauthorized');
    await expectAdapterError(fakeGitHub({ [path]: { status: 403, body: { message: 'Resource not accessible' } } }).scm.comment(pr, 'x'), 'forbidden');
    const limited = await expectAdapterError(
      fakeGitHub({ [path]: { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0' } } }).scm.comment(pr, 'x'),
      'rate_limited',
    );
    expect(limited).toMatchObject({ retryable: true, retryAfterSeconds: 60 });
    expect((await expectAdapterError(fakeGitHub({ [path]: { status: 502 } }).scm.comment(pr, 'x'), 'unavailable')).retryable).toBe(true);
  });

  it('reports a missing token as unauthorized and retries the provider next time', async () => {
    let attempts = 0;
    const scm = new GitHubSourceControl({
      token: async () => {
        attempts++;
        throw new Error('no token');
      },
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    await expectAdapterError(scm.comment(pr, 'x'), 'unauthorized');
    await expectAdapterError(scm.comment(pr, 'x'), 'unauthorized');
    expect(attempts).toBe(2);
  });

  it('never puts the token in an error message', async () => {
    const scm = new GitHubSourceControl({ token: async () => 'tok_secret_123', fetch: (async () => new Response('{"message":"nope"}', { status: 400 })) as typeof fetch });
    const error = (await scm.comment(pr, 'x').catch((e: unknown) => e)) as AdapterError;
    expect(error.message).not.toContain('tok_secret_123');
  });
});
