// @cradleworks/interfaces: the only package the core depends on.
// Every external system sits behind one of these interfaces (Build spec, section 5).

export * from './common.ts';
export type * from './source-control.ts';
export type * from './ci.ts';
export type * from './tracker.ts';
export type * from './agent-events.ts';
export type * from './agent-runtime.ts';
export type * from './model-provider.ts';
export type * from './sandbox.ts';
export type * from './notifier.ts';
export type * from './state-store.ts';
export type * from './spec-store.ts';

export const INTERFACES_VERSION = '0.1.0';
