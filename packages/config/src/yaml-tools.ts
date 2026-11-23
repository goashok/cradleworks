// Small YAML helpers for files other than factory.yaml: eval suites, tasks and config variants.

import { parse, stringify } from 'yaml';

/** Parses YAML into plain values; throws with the file name on a syntax error. */
export function parseYaml(text: string, file: string): unknown {
  try {
    return parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message.split('\n')[0]}`);
  }
}

export const stringifyYaml = (value: unknown): string => stringify(value, { lineWidth: 0 });

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `over` laid on `base` the way factory.yaml lies on the defaults: maps merge key by key, lists
 * and single values replace. A `null` in `over` removes the key.
 */
export function overlay(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = overlay(base[key], value);
  }
  return out;
}
