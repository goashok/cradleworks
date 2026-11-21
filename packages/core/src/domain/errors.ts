/** Thrown when an event is not allowed in the current state. Nothing is applied. */
export class IllegalTransitionError extends Error {
  readonly eventType: string;
  readonly state: string;

  constructor(eventType: string, state: string, detail: string) {
    super(`${eventType} not allowed in state ${state}: ${detail}`);
    this.name = 'IllegalTransitionError';
    this.eventType = eventType;
    this.state = state;
  }
}
