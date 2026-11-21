import { AdapterError, type AdapterErrorCode } from '@cradleworks/interfaces';
import { expect } from 'vitest';

/** Awaits `promise` and asserts it rejects with an AdapterError of `code`. */
export async function expectAdapterError(promise: Promise<unknown>, code: AdapterErrorCode): Promise<AdapterError> {
  const outcome = await promise.then(
    (value: unknown) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (outcome.ok) throw new Error(`expected AdapterError "${code}", but the call succeeded`);
  expect(outcome.error).toBeInstanceOf(AdapterError);
  expect((outcome.error as AdapterError).code).toBe(code);
  return outcome.error as AdapterError;
}
