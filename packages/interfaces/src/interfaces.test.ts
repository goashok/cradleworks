import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AdapterError,
  ZERO_USAGE,
  type AgentEvent,
  type AgentRuntime,
  type CI,
  type ModelProvider,
  type Notifier,
  type Sandbox,
  type SourceControl,
  type SpecStore,
  type StateStore,
  type Tracker,
} from './index.ts';

// Minimal fakes: if an interface gains or loses a member, these stop compiling.
// Real signatures are exercised by each adapter's contract tests (M1-6).
const notImplemented = (): never => {
  throw new Error('not implemented');
};

async function* none<T>(): AsyncIterable<T> {}

const fakes = {
  sourceControl: {
    id: 'fake',
    clone: notImplemented,
    createBranch: notImplemented,
    commit: notImplemented,
    push: notImplemented,
    openPR: notImplemented,
    getPRStatus: notImplemented,
    merge: notImplemented,
    comment: notImplemented,
  } satisfies SourceControl,
  ci: {
    id: 'fake',
    trigger: notImplemented,
    findRuns: notImplemented,
    getRunStatus: notImplemented,
    getArtifacts: notImplemented,
    downloadArtifact: notImplemented,
    getLogs: notImplemented,
  } satisfies CI,
  tracker: {
    id: 'fake',
    watch: () => none(),
    getItem: notImplemented,
    comment: notImplemented,
    setStatus: notImplemented,
    link: notImplemented,
  } satisfies Tracker,
  agentRuntime: {
    id: 'fake',
    start: async (request) => ({
      runId: request.runId,
      events: none<AgentEvent>(),
      stop: async () => {},
      getUsage: async () => ZERO_USAGE,
    }),
  } satisfies AgentRuntime,
  modelProvider: {
    id: 'fake',
    complete: notImplemented,
    stream: () => none(),
    countTokens: async () => 0,
    price: () => 0,
  } satisfies ModelProvider,
  sandbox: {
    id: 'fake',
    create: notImplemented,
    exec: notImplemented,
    spawn: notImplemented,
    copyIn: notImplemented,
    copyOut: notImplemented,
    setNetworkPolicy: notImplemented,
    destroy: async () => {},
  } satisfies Sandbox,
  notifier: { id: 'fake', notify: async () => {} } satisfies Notifier,
  stateStore: {
    id: 'fake',
    append: notImplemented,
    readStream: async () => [],
    query: async () => [],
    saveSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    close: async () => {},
  } satisfies StateStore,
  specStore: {
    id: 'fake',
    save: notImplemented,
    get: async () => undefined,
    listVersions: async () => [],
    approve: notImplemented,
  } satisfies SpecStore,
};

describe('adapter interfaces', () => {
  it('can each be implemented', () => {
    expect(Object.keys(fakes)).toHaveLength(9);
  });

  it('narrow agent events by type', () => {
    const event = { type: 'usage', runId: 'r1', seq: 1, at: '2026-11-21T00:00:00.000Z', total: ZERO_USAGE } as AgentEvent;
    if (event.type === 'usage') expectTypeOf(event.total.costUsd).toEqualTypeOf<number>();
    if (event.type === 'done') expectTypeOf(event.outcome).toEqualTypeOf<
      'succeeded' | 'failed' | 'stopped' | 'timed_out' | 'limit_reached'
    >();
  });
});

describe('AdapterError', () => {
  it('marks transient codes retryable by default', () => {
    const e = new AdapterError('rate_limited', 'slow down', { adapter: 'fake', operation: 'openPR', retryAfterSeconds: 30 });
    expect(e).toBeInstanceOf(Error);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSeconds).toBe(30);
  });

  it('marks other codes not retryable unless told', () => {
    expect(new AdapterError('conflict', 'moved', { adapter: 'fake', operation: 'merge' }).retryable).toBe(false);
    expect(new AdapterError('unknown', '?', { adapter: 'fake', operation: 'x', retryable: true }).retryable).toBe(true);
  });
});
