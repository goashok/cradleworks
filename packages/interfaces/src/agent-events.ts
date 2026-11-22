import type { Timestamp, Usage } from './common.ts';

// Normalised events every AgentRuntime emits, whatever agent it drives.
// The core logs them, meters spend from `usage`, and treats `done` as the end of the stream.

interface AgentEventBase {
  runId: string;
  /** Strictly increasing within a run, starting at 1. */
  seq: number;
  at: Timestamp;
}

export interface AgentMessageEvent extends AgentEventBase {
  type: 'message';
  role: 'assistant' | 'system';
  text: string;
}

export interface AgentToolCallEvent extends AgentEventBase {
  type: 'tool_call';
  callId: string;
  tool: string;
  input: unknown;
}

/**
 * Result of a tool call. Not in the spec's original five events: added so every
 * command's exit status is in the audit log (spec section 7, "every command is logged").
 */
export interface AgentToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  callId: string;
  isError: boolean;
  /** Possibly truncated by the runtime; full output stays in the workspace. */
  output: string;
}

export interface AgentFileChangeEvent extends AgentEventBase {
  type: 'file_change';
  /** Relative to the workspace root. */
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
}

/** The runtime refused a tool call or command under the run's policy. */
export interface AgentDeniedEvent extends AgentEventBase {
  type: 'denied';
  tool: string;
  /** What was asked for, e.g. the command line. */
  detail: string;
}

export interface AgentUsageEvent extends AgentEventBase {
  type: 'usage';
  /** Running total for the whole run, not a delta. */
  total: Usage;
}

export type AgentOutcome = 'succeeded' | 'failed' | 'stopped' | 'timed_out' | 'limit_reached';

export interface AgentDoneEvent extends AgentEventBase {
  type: 'done';
  outcome: AgentOutcome;
  /** The agent's own summary of what it did, if it gave one. */
  summary?: string;
  error?: string;
  total: Usage;
}

export type AgentEvent =
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentFileChangeEvent
  | AgentDeniedEvent
  | AgentUsageEvent
  | AgentDoneEvent;

export type AgentEventType = AgentEvent['type'];
