#!/usr/bin/env node
import { run } from './cli.ts';

// The first Ctrl-C lets `factory watch` finish the steps it is in; the second stops at once.
// Anything cut off is picked up again the next time watch starts.
const stop = new AbortController();
for (const signal of process.argv[2] === 'watch' ? (['SIGINT', 'SIGTERM'] as const) : []) {
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(130);
    process.stderr.write('\nStopping after the current steps; press Ctrl-C again to stop now.\n');
    stop.abort();
  });
}

const code = await run(process.argv.slice(2), {
  signal: stop.signal,
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
