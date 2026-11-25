// Which StateStore the CLI uses: PostgreSQL when CRADLEWORKS_DATABASE_URL is set (a factory run
// as a service, or a team sharing one database), otherwise SQLite in the factory home.

import { join } from 'node:path';
import type { StateStore } from '@cradleworks/interfaces';
import { PostgresStateStore } from '@cradleworks/store-postgres';
import { SqliteStateStore } from '@cradleworks/store-sqlite';

export async function openStore(env: Record<string, string | undefined>, home: string): Promise<StateStore> {
  const url = env.CRADLEWORKS_DATABASE_URL?.trim();
  if (!url) return new SqliteStateStore({ path: join(home, 'state.db') });
  const schema = env.CRADLEWORKS_DATABASE_SCHEMA?.trim();
  const tenant = env.CRADLEWORKS_TENANT?.trim();
  return PostgresStateStore.open({ connectionString: url, ...(schema ? { schema } : {}), ...(tenant ? { tenant } : {}) });
}
