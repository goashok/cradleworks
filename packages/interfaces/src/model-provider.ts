import type { Usage } from './common.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Model id from config; opaque to the core. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  /** `json` asks for a single JSON value as the whole reply. */
  responseFormat?: 'text' | 'json';
}

export type StopReason = 'end' | 'max_tokens' | 'stop_sequence' | 'refused' | 'other';

export interface Completion {
  model: string;
  text: string;
  stopReason: StopReason;
  usage: Usage;
}

export type CompletionChunk = { type: 'text'; text: string } | { type: 'done'; completion: Completion };

export interface ModelProvider {
  readonly id: string;

  complete(request: CompletionRequest, signal?: AbortSignal): Promise<Completion>;
  /** Yields text chunks, then exactly one `done` chunk. */
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<CompletionChunk>;
  countTokens(request: CompletionRequest): Promise<number>;
  /** Cost in US dollars of `usage` on `model`. */
  price(model: string, usage: Omit<Usage, 'costUsd'>): number;
}
