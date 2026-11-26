// The console's buttons as CLI commands. Shared by the local console and any hosted one, so a
// button always runs the same command, with the same rules, as typing it.

/** Maps a button to the CLI command it stands for. Unknown actions or missing fields are refused. */
export function commandFor(form: Record<string, string>): string[] | undefined {
  const id = form.id ?? '';
  if (!/^(wi|task)_[A-Za-z0-9-]+$/.test(id)) return undefined;
  const reason = form.reason?.trim();
  switch (form.action) {
    case 'approve':
      return ['approve', id, ...(reason ? ['--reason', reason] : [])];
    // Merging is for tasks only: `approve <wi> --merge` would mean nothing at the spec gate.
    case 'approve_merge':
      return id.startsWith('task_') ? ['approve', id, '--merge', ...(reason ? ['--reason', reason] : [])] : undefined;
    case 'merge':
      return id.startsWith('task_') ? ['approve', id, '--merge'] : undefined;
    case 'reject':
      return reason ? ['reject', id, '--reason', reason, '--no-run'] : undefined;
    case 'retry':
      return ['retry', id, '--no-run'];
    case 'extend': {
      const usd = Number(form.usd);
      return Number.isFinite(usd) && usd > 0 ? ['budget', 'extend', id, '--usd', String(usd), '--no-run'] : undefined;
    }
    case 'cancel':
      return reason ? ['cancel', id, '--reason', reason] : undefined;
    default:
      return undefined;
  }
}
