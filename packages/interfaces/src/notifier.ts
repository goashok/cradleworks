import type { GateName } from './common.ts';

export interface Notification {
  gate: GateName;
  subject: { kind: 'work_item' | 'spec' | 'task'; id: string; title: string };
  /** Where the person acts: a pull request, a spec, a console page. */
  link: string;
  message?: string;
}

export interface Notifier {
  readonly id: string;
  notify(notification: Notification): Promise<void>;
}
