// Child process for the multi-process test: appends `count` events to one stream,
// each with expectedSeq from its own read, retrying on conflict.
// Usage: node concurrent-writer.fixture.ts <dbPath> <writerId> <count>

import { AdapterError } from '@cradleworks/interfaces';
import { SqliteStateStore } from './index.ts';

const [path, writer, countText] = process.argv.slice(2);
if (!path || !writer || !countText) throw new Error('usage: <dbPath> <writerId> <count>');

const store = new SqliteStateStore({ path, busyTimeoutMs: 10_000 });
let conflicts = 0;
for (let i = 0; i < Number(countText); i++) {
  for (;;) {
    const last = (await store.readStream('shared')).at(-1)?.seq ?? 0;
    try {
      await store.append('shared', [{ type: 'tick', payload: { writer, i }, at: new Date().toISOString() }], last);
      break;
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'conflict') {
        conflicts++;
        continue;
      }
      throw error;
    }
  }
}
await store.close();
process.stdout.write(JSON.stringify({ writer, conflicts }));
