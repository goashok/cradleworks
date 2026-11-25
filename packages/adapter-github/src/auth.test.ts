import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_PERMISSIONS, appJwt, githubAppTokenProvider, personalTokenProvider, tokenProviderFromEnv } from './auth.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

describe('GitHub App tokens', () => {
  it('signs the app JWT with RS256, backdated a minute and valid nine more', () => {
    const jwt = appJwt('12345', privateKey, 1_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: '12345' });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('mints an installation token with only the permissions it needs, and refreshes it near expiry', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    let clock = 1_000_000;
    let n = 0;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Bearer ey/);
      if (url.endsWith('/app/installations')) return Response.json([{ id: 77 }]);
      return Response.json({ token: `ghs_${++n}`, expires_at: new Date((clock + 3600) * 1000).toISOString() }, { status: 201 });
    }) as typeof fetch;
    const provider = githubAppTokenProvider({ appId: '1', privateKey, repositories: ['ref-orders-service'], fetch: fake, now: () => clock });
    expect(await Promise.all([provider(), provider()])).toEqual(['ghs_1', 'ghs_1']);
    clock += 3000; // 10 minutes left: still good
    expect(await provider()).toBe('ghs_1');
    clock += 400; // under 5 minutes left: refresh
    expect(await provider()).toBe('ghs_2');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/app/installations',
      'POST https://api.github.com/app/installations/77/access_tokens',
      'GET https://api.github.com/app/installations',
      'POST https://api.github.com/app/installations/77/access_tokens',
    ]);
    expect(calls[1]!.body).toEqual({ permissions: APP_PERMISSIONS, repositories: ['ref-orders-service'] });
  });

  it('is off unless configured, and says what is missing', () => {
    expect(tokenProviderFromEnv({})).toBe(personalTokenProvider);
    expect(() => tokenProviderFromEnv({ CRADLEWORKS_GITHUB_APP_ID: '1' })).toThrow(/both CRADLEWORKS_GITHUB_APP_ID and CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE/);
    expect(tokenProviderFromEnv({ CRADLEWORKS_GITHUB_APP_ID: '1', CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE: '/nonexistent' })).not.toBe(personalTokenProvider);
  });

  it('takes the key itself from CRADLEWORKS_GITHUB_APP_PRIVATE_KEY, newlines written as \\n too', async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${String(url).replace('https://api.github.com', '')}`);
      const [h, p, s] = String((init.headers as Record<string, string>).authorization).slice('Bearer '.length).split('.');
      expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
      return new Response(JSON.stringify({ token: 'ghs_app', expires_at: '2099-01-01T00:00:00Z' }), { status: 201 });
    }) as typeof fetch;
    try {
      const provider = tokenProviderFromEnv({ CRADLEWORKS_GITHUB_APP_ID: '7', CRADLEWORKS_GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'), CRADLEWORKS_GITHUB_APP_INSTALLATION_ID: '42' });
      expect(await provider()).toBe('ghs_app');
      expect(seen).toEqual(['POST /app/installations/42/access_tokens']);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(() => tokenProviderFromEnv({ CRADLEWORKS_GITHUB_APP_ID: '7', CRADLEWORKS_GITHUB_APP_PRIVATE_KEY: 'k', CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE: '/f' })).toThrow(/not both/);
  });
});
