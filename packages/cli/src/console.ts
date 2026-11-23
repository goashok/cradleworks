// `factory console`: a local web page over the factory's store. It shows work items, their tasks,
// what waits on a person, spend, and each run's log; and its buttons run the same commands as the
// CLI (approve, reject, retry, extend a budget, cancel), with the same rules.
//
// Bound to 127.0.0.1 only. Every action needs this process's random token, which only its own pages
// carry, and a same-origin request, so another site in the browser can't press the buttons.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WorkItemRepository, type WorkItem } from '@cradleworks/core';
import { SqliteStateStore } from '@cradleworks/store-sqlite';
import { formatLog } from './log.ts';

export interface ConsoleOptions {
  home: string;
  port: number;
  /** Runs a CLI command and returns its exit code and output; the buttons use it. */
  runCommand: (argv: string[]) => Promise<{ code: number; output: string }>;
  token?: string;
}

const WAITING = new Set(['awaiting_spec_approval', 'awaiting_change_approval', 'blocked']);
const TASK_WAITING = new Set(['escalated', 'budget_exceeded', 'failed']);

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`;

function page(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="10">' : ''}<title>${esc(title)} · Cradleworks</title><style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2de;--accent:#2f5bd3;--warn:#a5520c;--warnbg:#fdf3e7;--ok:#1d7a46;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#9b9a95;--line:#2e2d2a;--accent:#7d9cf0;--warn:#e9a35c;--warnbg:#2b2117;--ok:#5cc28a;--card:#1d1d1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header b{font-size:16px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 16px}h2{font-size:16px;margin:24px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
tr:last-child td{border-bottom:0}a{color:var(--accent)}.muted{color:var(--muted)}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.state{font-size:13px;padding:1px 8px;border-radius:10px;border:1px solid var(--line);white-space:nowrap}.wait{background:var(--warnbg);color:var(--warn);border-color:transparent}.ok{color:var(--ok)}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;font:12.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
form{display:inline-flex;gap:6px;margin:4px 8px 4px 0;flex-wrap:wrap}input[type=text],input[type=number]{padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg);font:inherit;min-width:0}
button{padding:5px 12px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}
.notice{padding:10px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);margin-bottom:16px;white-space:pre-wrap}
.scroll{overflow-x:auto}@media (max-width:640px){.hide-sm{display:none}}
</style></head><body><header><b>Cradleworks</b><a href="/">Work</a><a href="/waiting">Waiting on a person</a></header><main>${body}</main></body></html>`;
}

const stateChip = (state: string, waiting: boolean) => `<span class="state${waiting ? ' wait' : state === 'merged' ? ' ok' : ''}">${esc(state.replace(/_/g, ' '))}</span>`;

function needsPerson(wi: WorkItem): boolean {
  return WAITING.has(wi.state) || wi.tasks.some((t) => TASK_WAITING.has(t.state) || (t.state === 'ready' && !t.changeApproved));
}

export function listPage(items: WorkItem[], filter: 'all' | 'waiting'): string {
  const shown = filter === 'waiting' ? items.filter(needsPerson) : items;
  const rows = shown.map((wi) => {
    const done = wi.tasks.filter((t) => t.state === 'merged').length;
    return `<tr><td><a href="/wi/${esc(wi.id)}">${esc(wi.title)}</a><div class="muted hide-sm">${esc(wi.projectId)} · ${esc(wi.id)}</div></td>
<td>${stateChip(wi.state, needsPerson(wi))}</td><td class="num">${done}/${wi.tasks.length}</td><td class="num">${money(wi.spentUsd)}</td><td class="muted hide-sm">${esc(wi.requester ?? '')}</td></tr>`;
  });
  const title = filter === 'waiting' ? 'Waiting on a person' : 'Work';
  const empty = filter === 'waiting' ? 'Nothing is waiting on a person.' : 'No work items yet.';
  return page(title, `<h1>${title}</h1>${rows.length ? `<div class="scroll"><table><tr><th>Work item</th><th>State</th><th>Tasks</th><th>Spent</th><th class="hide-sm">Requester</th></tr>${rows.join('')}</table></div>` : `<p class="muted">${empty}</p>`}`, true);
}

function actions(wi: WorkItem, token: string): string {
  const form = (action: string, id: string, label: string, extra = '') =>
    `<form method="post" action="/action"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}">${extra}<button>${esc(label)}</button></form>`;
  const reason = '<input type="text" name="reason" placeholder="Reason" required>';
  const parts: string[] = [];
  if (wi.state === 'awaiting_spec_approval') {
    parts.push(`<div>${form('approve', wi.id, 'Approve the spec')}${form('reject', wi.id, 'Send the spec back', reason)}</div>`);
  }
  for (const t of wi.tasks) {
    const own: string[] = [];
    if (t.state === 'ready' && !t.changeApproved) own.push(form('approve', t.id, 'Approve change'), form('reject', t.id, 'Send back', reason));
    if (t.state === 'escalated' || t.state === 'failed') own.push(form('retry', t.id, 'Retry'));
    if (t.state === 'budget_exceeded') own.push(form('extend', t.id, 'Extend budget', '<input type="number" name="usd" min="0.5" step="0.5" value="5" style="width:80px">'));
    if (own.length) parts.push(`<div><span class="muted">${esc(t.title)}:</span> ${own.join('')}</div>`);
  }
  if (!['merged', 'cancelled'].includes(wi.state)) parts.push(`<div>${form('cancel', wi.id, 'Cancel work item', reason)}</div>`);
  return parts.length ? `<h2>Actions</h2>${parts.join('')}` : '';
}

export function workItemPage(wi: WorkItem, description: string, token: string, notice?: string): string {
  const tasks = wi.tasks.map((t) => {
    const waiting = TASK_WAITING.has(t.state) || (t.state === 'ready' && !t.changeApproved);
    return `<tr><td>${esc(t.title)}<div class="muted hide-sm">${esc(t.id)}</div>${t.lastReason && waiting ? `<div class="muted">${esc(t.lastReason.slice(0, 400))}</div>` : ''}</td>
<td>${stateChip(t.state, waiting)}${t.protectedPaths?.length ? '<div class="muted">protected files</div>' : ''}</td><td class="num">${money(t.spentUsd)}</td><td>${t.pr ? `<a href="${esc(t.pr.url)}" rel="noreferrer">PR</a>` : ''}</td></tr>`;
  });
  const runs = wi.runs.map((r) => `<tr><td><a href="/run/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.station)}</td><td>${esc(r.outcome ?? 'running')}</td></tr>`);
  const body = `${notice ? `<div class="notice">${esc(notice)}</div>` : ''}<h1>${esc(wi.title)}</h1>
<p>${stateChip(wi.state, needsPerson(wi))} <span class="muted">${esc(wi.projectId)} · spent ${money(wi.spentUsd)}${wi.source.url ? ` · <a href="${esc(wi.source.url)}" rel="noreferrer">issue</a>` : ''}</span></p>
${actions(wi, token)}
<h2>Tasks</h2>${tasks.length ? `<div class="scroll"><table><tr><th>Task</th><th>State</th><th>Spent</th><th></th></tr>${tasks.join('')}</table></div>` : '<p class="muted">Not planned yet.</p>'}
<h2>Runs</h2>${runs.length ? `<div class="scroll"><table><tr><th>Run</th><th>Station</th><th>Outcome</th></tr>${runs.join('')}</table></div>` : '<p class="muted">None yet.</p>'}
<h2>Details</h2><pre>${esc(description)}</pre>`;
  return page(wi.title, body, !notice);
}

export function runPage(runId: string, log: string): string {
  return page(runId, `<h1>${esc(runId)}</h1><pre>${esc(log)}</pre>`, false);
}

/** Maps a button to the CLI command it stands for. Unknown actions or missing fields are refused. */
export function commandFor(form: Record<string, string>): string[] | undefined {
  const id = form.id ?? '';
  if (!/^(wi|task)_[A-Za-z0-9-]+$/.test(id)) return undefined;
  const reason = form.reason?.trim();
  switch (form.action) {
    case 'approve':
      return ['approve', id, ...(reason ? ['--reason', reason] : [])];
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

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('form too large');
  }
  return Object.fromEntries(new URLSearchParams(body));
}

/** Same-origin: the browser says where the form came from, and it must be this console. */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const origin = req.headers.origin ?? req.headers.referer ?? '';
  const host = req.headers.host ?? '';
  const ok = [`127.0.0.1:${port}`, `localhost:${port}`];
  return ok.includes(host) && ok.some((h) => origin === `http://${h}` || origin.startsWith(`http://${h}/`));
}

export function startConsole(options: ConsoleOptions, describeWorkItem: (wi: WorkItem) => string): Promise<{ server: Server; url: string; token: string }> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const store = new SqliteStateStore({ path: join(options.home, 'state.db') });
  const repo = new WorkItemRepository(store);
  const items = async () => {
    const received = await store.query({ types: ['work_item_received'] });
    const out: WorkItem[] = [];
    for (const e of received.reverse()) {
      const wi = await repo.load(e.streamId);
      if (wi) out.push(wi);
    }
    return out;
  };
  const send = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'referrer-policy': 'same-origin' });
    res.end(html);
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/waiting')) return send(res, 200, listPage(await items(), url.pathname === '/' ? 'all' : 'waiting'));
      const wiMatch = /^\/wi\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && wiMatch) {
        const wi = await repo.load(wiMatch[1]!);
        return wi ? send(res, 200, workItemPage(wi, describeWorkItem(wi), token, url.searchParams.get('notice') ?? undefined)) : send(res, 404, page('Not found', '<p>No such work item.</p>', false));
      }
      const runMatch = /^\/run\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && runMatch) {
        const events = await store.query({ streamIds: [runMatch[1]!] });
        return events.length ? send(res, 200, runPage(runMatch[1]!, formatLog(events, { full: true }))) : send(res, 404, page('Not found', '<p>No such run.</p>', false));
      }
      if (req.method === 'POST' && url.pathname === '/action') {
        const form = await readForm(req);
        if (form.token !== token || !sameOrigin(req, options.port)) return send(res, 403, page('Refused', '<p>This action did not come from this console.</p>', false));
        const argv = commandFor(form);
        if (!argv) return send(res, 400, page('Refused', '<p>That action is missing something it needs.</p>', false));
        const { code, output } = await options.runCommand(argv);
        const target = form.id!.startsWith('wi_') ? form.id! : ((await items()).find((wi) => wi.tasks.some((t) => t.id === form.id))?.id ?? '');
        const notice = `${code === 0 ? 'Done' : 'Not done'}: factory ${argv.join(' ')}\n${output.trim()}${code === 0 && argv.includes('--no-run') ? '\nThe next factory watch pass carries it on.' : ''}`;
        res.writeHead(303, { location: target ? `/wi/${target}?notice=${encodeURIComponent(notice)}` : '/' });
        return res.end();
      }
      send(res, 404, page('Not found', '<p>Nothing here.</p>', false));
    })().catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, page('Error', `<pre>${esc((error as Error).message)}</pre>`, false));
    });
  });
  server.on('close', () => void store.close());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      options.port = port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, token });
    });
  });
}
