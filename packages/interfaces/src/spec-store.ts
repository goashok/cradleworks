import type { Timestamp } from './common.ts';

export interface SpecApproval {
  by: string;
  at: Timestamp;
}

export interface SpecDocument {
  id: string;
  workItemId: string;
  /** Starts at 1; every save of a changed spec is a new version. */
  version: number;
  title: string;
  problem: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  /** What the spec agent assumed where the request was silent; the spec gate checks them. */
  assumptions?: string[];
  approval?: SpecApproval;
}

/** Where specs live: the target repo or the factory's own store, chosen per project. */
export interface SpecStore {
  readonly id: string;

  /** Saves a new version and returns it as stored. */
  save(spec: Omit<SpecDocument, 'version'>): Promise<SpecDocument>;
  /** Latest version when `version` is omitted. */
  get(specId: string, version?: number): Promise<SpecDocument | undefined>;
  listVersions(specId: string): Promise<number[]>;
  approve(specId: string, version: number, approval: SpecApproval): Promise<SpecDocument>;
}
