// The factory core: pipeline, state machine, domain model and policies.
// It must not name any vendor, stack or project (see scripts/check-core-rule.ts).
export * from './domain/index.ts';

export const CORE_VERSION = '0.1.0';
export type * from './config/types.ts';
export { resolveAgent } from './config/types.ts';
