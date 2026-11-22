// Specs in the factory's own event log: every version is an event on the spec's stream,
// so drafts never touch the repo. With `specs: repo`, the approved version is also written
// to `.factory/specs/` by the first task's pull request.

import type { SpecApproval, SpecDocument, SpecStore, StateStore } from '@cradleworks/interfaces';

export class EventSpecStore implements SpecStore {
  readonly id = 'factory';
  readonly #store: StateStore;
  readonly #clock: () => string;

  constructor(store: StateStore, clock: () => string = () => new Date().toISOString()) {
    this.#store = store;
    this.#clock = clock;
  }

  async save(spec: Omit<SpecDocument, 'version'>): Promise<SpecDocument> {
    const latest = (await this.#all(spec.id)).at(-1);
    const { approval: _ignored, ...content } = spec;
    const doc: SpecDocument = { ...content, version: (latest?.version ?? 0) + 1 };
    await this.#store.append(spec.id, [{ type: 'spec_saved', payload: doc as unknown as Record<string, unknown>, at: this.#clock() }]);
    return doc;
  }

  async get(specId: string, version?: number): Promise<SpecDocument | undefined> {
    const all = await this.#all(specId);
    return version === undefined ? all.at(-1) : all.find((d) => d.version === version);
  }

  async listVersions(specId: string): Promise<number[]> {
    return (await this.#all(specId)).map((d) => d.version);
  }

  async approve(specId: string, version: number, approval: SpecApproval): Promise<SpecDocument> {
    const doc = await this.get(specId, version);
    if (!doc) throw new Error(`no spec ${specId} version ${version}`);
    await this.#store.append(specId, [{ type: 'spec_approved', payload: { version, ...approval }, at: this.#clock() }]);
    return { ...doc, approval };
  }

  async #all(specId: string): Promise<SpecDocument[]> {
    const docs: SpecDocument[] = [];
    for (const e of await this.#store.readStream(specId)) {
      if (e.type === 'spec_saved') docs.push(e.payload as unknown as SpecDocument);
      if (e.type === 'spec_approved') {
        const p = e.payload as { version: number; by: string; at: string };
        const doc = docs.find((d) => d.version === p.version);
        if (doc) doc.approval = { by: p.by, at: p.at };
      }
    }
    return docs;
  }
}
