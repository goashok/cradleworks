// For tests only: a Postgres server to test against. CRADLEWORKS_TEST_POSTGRES_URL when set,
// otherwise a throwaway container (removed by `stop`). Undefined when neither is available.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DockerSandbox, findDocker } from '@cradleworks/adapter-local';
import pg from 'pg';

const IMAGE = 'postgres:17-alpine';

/** A server for this file: from the environment, or a container started here. */
export async function testServer(): Promise<{ url: string; stop: () => void } | undefined> {
  const given = process.env.CRADLEWORKS_TEST_POSTGRES_URL;
  if (given) return { url: given, stop: () => undefined };
  const docker = findDocker();
  if (!(await DockerSandbox.available(docker))) return undefined;
  const password = randomBytes(12).toString('hex');
  let id: string;
  try {
    // Pull only when missing: a registry hiccup shouldn't skip the tests when the image is here.
    try {
      execFileSync(docker, ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    } catch {
      execFileSync(docker, ['pull', '--quiet', IMAGE], { stdio: 'ignore' });
    }
    id = execFileSync(docker, ['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', IMAGE], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  const stop = () => void execFileSync(docker, ['rm', '-f', id], { stdio: 'ignore' });
  const port = execFileSync(docker, ['port', id, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 60; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return { url, stop };
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  stop();
  return undefined;
}

