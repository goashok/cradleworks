// Shared value types used across adapter interfaces.
// Nothing here may name a vendor: references into external systems are opaque.

/** ISO-8601 timestamp, e.g. "2026-11-21T13:20:00.000Z". */
export type Timestamp = string;

/** A pointer into an external system. `id` is opaque to the core; `url` is for humans. */
export interface ExternalRef {
  id: string;
  url: string;
}

export interface RepoRef extends ExternalRef {}
export interface PullRequestRef extends ExternalRef {}
export interface ItemRef extends ExternalRef {}
export interface CommentRef extends ExternalRef {}

export interface Identity {
  name: string;
  email?: string;
  /** Account handle in the external system, if any. */
  handle?: string;
}

/** Token and spend usage. Spend is in US dollars. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Hard limits for one agent run or model call. Omitted = no limit at this level. */
export interface Limits {
  maxTokens?: number;
  maxWallSeconds?: number;
  maxSpendUsd?: number;
}

/** The gates in the pipeline. */
export type GateName = 'spec_approval' | 'plan_check' | 'change_approval';

/** Where the factory is with an external item; trackers map these to their own labels or states. */
export type FactoryStatus =
  | 'received'
  | 'specifying'
  | 'awaiting_spec_approval'
  | 'planning'
  | 'in_progress'
  | 'awaiting_change_approval'
  | 'merged'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type AdapterErrorCode =
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_input'
  | 'timeout'
  | 'unknown';

export interface AdapterErrorOptions {
  /** Adapter that raised the error, e.g. its registry id. */
  adapter: string;
  operation: string;
  retryable?: boolean;
  /** Seconds to wait before retrying, when the external system says so. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** The only error type adapters throw. The core decides on retries from `code` and `retryable`. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly adapter: string;
  readonly operation: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AdapterErrorCode, message: string, options: AdapterErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'AdapterError';
    this.code = code;
    this.adapter = options.adapter;
    this.operation = options.operation;
    this.retryable = options.retryable ?? (code === 'rate_limited' || code === 'unavailable' || code === 'timeout');
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
