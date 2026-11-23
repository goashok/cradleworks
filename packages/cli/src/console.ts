// `factory console`: a local web page over the factory's store. It shows work items, their tasks,
// what waits on a person, spend, and each run's log; and its buttons run the same commands as the
// CLI (approve, reject, retry, extend a budget, cancel), with the same rules.
//
// Bound to 127.0.0.1 only. Every action needs this process's random token, which only its own pages
// carry, and a same-origin request, so another site in the browser can't press the buttons.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { EventSpecStore, WorkItemRepository, type WorkItem } from '@cradleworks/core';
import type { SpecDocument, StoredEvent } from '@cradleworks/interfaces';
import { SqliteStateStore } from '@cradleworks/store-sqlite';
import { chip, costByRun, esc, headline, money, runBody, runsTable, specSection, steps, story, storySection, taskCard } from './console-view.ts';
import { formatLog } from './log.ts';

export { esc } from './console-view.ts';

export interface ConsoleOptions {
  home: string;
  port: number;
  /** Runs a CLI command and returns its exit code and output; the buttons use it. */
  runCommand: (argv: string[]) => Promise<{ code: number; output: string }>;
  token?: string;
}

const WAITING = new Set(['awaiting_spec_approval', 'awaiting_change_approval', 'blocked']);
const TASK_WAITING = new Set(['escalated', 'budget_exceeded', 'failed']);


function page(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="10">' : ''}<title>${esc(title)} · Cradleworks</title><style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2de;--accent:#2f5bd3;--card:#fff;--soft:#f4f3f0;
--ok:#1d7a46;--okbg:#e6f4ea;--warn:#9a4a07;--warnbg:#fdf0e1;--bad:#b42318;--badbg:#fdecea;--busy:#2f5bd3;--busybg:#e8eefc}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#9b9a95;--line:#2e2d2a;--accent:#8aa6f2;--card:#1d1d1b;--soft:#232220;
--ok:#6fd19a;--okbg:#17301f;--warn:#efae6a;--warnbg:#33240f;--bad:#f08a80;--badbg:#3a1714;--busy:#8aa6f2;--busybg:#1b2440}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header b{font-size:16px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--fg)}
main{max-width:1000px;margin:0 auto;padding:16px 16px 48px;overflow-wrap:anywhere}h1{font-size:22px;margin:4px 0 6px;line-height:1.3}h2{font-size:17px;margin:28px 0 10px}
.card h2{margin:0 0 10px}h3{font-size:15px;margin:14px 0 6px}.card h3:first-child{margin-top:0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
tr:last-child td{border-bottom:0}table.compact{width:auto;border:0;background:none}table.compact td{padding:3px 18px 3px 0;border:0}
a{color:var(--accent)}.muted{color:var(--muted)}.small{font-size:13px}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.chip{display:inline-block;font-size:12.5px;font-weight:500;padding:1px 9px;border-radius:999px;white-space:nowrap;vertical-align:middle;background:var(--soft);color:var(--muted)}
.chip.ok{background:var(--okbg);color:var(--ok)}.chip.wait{background:var(--warnbg);color:var(--warn)}.chip.bad{background:var(--badbg);color:var(--bad)}.chip.busy{background:var(--busybg);color:var(--busy)}
.ok-t{color:var(--ok)}.bad-t{color:var(--bad)}
.state{font-size:13px;padding:1px 8px;border-radius:10px;border:1px solid var(--line);white-space:nowrap}.state.wait{background:var(--warnbg);color:var(--warn);border-color:transparent}.state.ok{color:var(--ok)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}.card.attention{border-color:var(--warn);box-shadow:0 0 0 1px var(--warnbg)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row h1,.row h2,.row h3{margin:0}
.headline{font-size:16px;padding:12px 14px;border-radius:10px;margin:12px 0;background:var(--soft)}.headline.wait{background:var(--warnbg);color:var(--fg);border-left:4px solid var(--warn)}
.headline.ok{background:var(--okbg);color:var(--fg)}.headline.bad{background:var(--badbg);color:var(--fg)}.headline.busy{background:var(--busybg);color:var(--fg)}
.lead{font-size:15.5px}.note{background:var(--warnbg);border-radius:6px;padding:8px 10px;font-size:14px}
.steps{display:flex;list-style:none;padding:0;margin:14px 0;gap:4px;flex-wrap:wrap}.steps li{flex:1 1 0;min-width:0;text-align:center;font-size:13px;padding:6px 4px;border-radius:6px;background:var(--soft);color:var(--muted)}
.steps li.done{background:var(--okbg);color:var(--ok)}.steps li.now{background:var(--busybg);color:var(--busy);font-weight:600}.steps li.stop{background:var(--warnbg);color:var(--warn);font-weight:600}.steps li.skip{opacity:.45;text-decoration:line-through}
.story{list-style:none;padding:0;margin:0;border-left:2px solid var(--line)}.story li{position:relative;padding:4px 0 8px 18px;display:flex;gap:12px;font-size:14px}
.story li::before{content:"";position:absolute;left:-6px;top:10px;width:10px;height:10px;border-radius:50%;background:var(--line)}
.story li.t-ok::before{background:var(--ok)}.story li.t-wait::before{background:var(--warn)}.story li.t-bad::before{background:var(--bad)}.story li.t-busy::before{background:var(--busy)}.story details{display:inline}.story summary{display:inline;color:var(--accent);font-size:13px}
.story .when{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums;min-width:96px}
.evidence{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}.cols{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:8px}@media (max-width:640px){.cols{grid-template-columns:1fr}}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}.sub{margin-top:8px}
.sub ul,.card ul,.card ol{margin:6px 0;padding-left:22px}.card li{margin:3px 0}
.msg{background:var(--soft);border-radius:10px;padding:10px 12px;margin:10px 0;white-space:pre-wrap;word-break:break-word}.msg.sys{font-size:13px;color:var(--muted)}.msg.denied{background:var(--badbg)}
details.tool{margin:4px 0 4px 12px;font-size:13.5px}details.tool>summary{cursor:pointer;list-style:none;padding:3px 6px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.tool>summary:hover{background:var(--soft)}details.tool>summary::-webkit-details-marker{display:none}details.tool.err>summary{color:var(--bad)}
.icon{display:inline-block;width:20px;text-align:center;color:var(--muted)}.tname{font-weight:600;margin-right:4px}
details>summary{cursor:pointer}.card>details{margin:6px 0}details.card>summary{list-style:none}.text{white-space:pre-wrap;font-size:14px;margin-top:6px}
.crumbs{font-size:13px;margin:0 0 6px}.crumbs a{color:var(--muted)}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;font:12.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:480px;overflow-y:auto}
form{display:inline-flex;gap:6px;margin:4px 8px 4px 0;flex-wrap:wrap}input[type=text],input[type=number]{padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg);font:inherit;min-width:0}
button{padding:5px 12px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}button.primary:hover{filter:brightness(1.1)}
button.danger{color:var(--bad);border-color:var(--bad)}button.danger:hover{background:var(--badbg)}
.actions.panel{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}.actions.panel .or{color:var(--muted);font-size:13px}.actions.panel form{margin:2px 0}.decide{display:flex;flex-wrap:wrap;gap:4px 8px}
.notice{padding:10px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);margin-bottom:16px;white-space:pre-wrap}
.actions{margin:8px 0}.scroll{overflow-x:auto}@media (max-width:640px){.hide-sm{display:none}.steps li{font-size:11px;padding:5px 2px}h1{font-size:19px}.card{padding:12px}details.tool{margin-left:0}}
</style></head><body><header><b>Cradleworks</b><a href="/">Work</a><a href="/waiting">Waiting on a person</a></header><main>${body}</main></body></html>`;
}

const stateChip = (state: string, waiting: boolean) => `<span class="state${waiting ? ' wait' : state === 'merged' ? ' ok' : ''}">${esc(state.replace(/_/g, ' '))}</span>`;

const FINISHED = new Set(['merged', 'failed', 'cancelled']);

function needsPerson(wi: WorkItem): boolean {
  if (FINISHED.has(wi.state)) return false;
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

function form(token: string, action: string, id: string, label: string, extra = '', kind: 'primary' | 'danger' | '' = ''): string {
  return `<form method="post" action="/action"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}">${extra}<button${kind ? ` class="${kind}"` : ''}>${esc(label)}</button></form>`;
}
const REASON = '<input type="text" name="reason" placeholder="Reason" required>';

/** The decisions one task waits on, as buttons; `named` puts the task's title on them. */
function taskActions(t: WorkItem['tasks'][number], token: string, named: boolean): string[] {
  const of = named ? ` “${t.title}”` : '';
  if (t.state === 'ready' && !t.changeApproved) return [form(token, 'approve', t.id, `Approve change${of}`, '', 'primary'), form(token, 'reject', t.id, 'Send back', REASON)];
  if (t.state === 'escalated' || t.state === 'failed') return [form(token, 'retry', t.id, `Retry${of}`, '', 'primary')];
  if (t.state === 'budget_exceeded') return [form(token, 'extend', t.id, `Extend budget${of}`, '<input type="number" name="usd" min="0.5" step="0.5" value="5" style="width:80px" aria-label="Extra US dollars">', 'primary')];
  return [];
}

/**
 * Every action open on the work item, in one place under the headline: what it waits on first,
 * then cancelling, which is always open until the work is finished.
 */
function workItemActions(wi: WorkItem, token: string): string {
  if (FINISHED.has(wi.state)) return '';
  const decide: string[] = [];
  if (wi.state === 'awaiting_spec_approval') decide.push(form(token, 'approve', wi.id, 'Approve the spec', '', 'primary'), form(token, 'reject', wi.id, 'Send the spec back', REASON));
  const waiting = wi.tasks.filter((t) => taskActions(t, token, false).length);
  for (const t of waiting) decide.push(...taskActions(t, token, waiting.length > 1));
  const cancel = form(token, 'cancel', wi.id, 'Cancel this work', '<input type="text" name="reason" placeholder="Why cancel?" required aria-label="Reason for cancelling">', 'danger');
  return `<div class="actions panel">${decide.length ? `<div class="decide">${decide.join('')}</div><div class="or">or</div>` : ''}<div>${cancel}</div></div>`;
}

export interface WorkItemExtras {
  /** The work item's own events, for its story and the cost of each run. */
  events?: StoredEvent[];
  spec?: SpecDocument;
}

export function workItemPage(wi: WorkItem, description: string, token: string, notice?: string, extras: WorkItemExtras = {}): string {
  const h = headline(wi);
  const events = extras.events ?? [];
  const source = wi.source.url ? ` · <a href="${esc(wi.source.url)}" rel="noreferrer">issue</a>` : '';
  const planned = wi.proposedTasks.length && !wi.tasks.length
    ? `<h2>Proposed plan</h2>${wi.proposedTasks.map((t) => `<section class="card"><h3>${esc(t.title)}</h3><p class="muted small">size ${esc(t.size)}</p>${t.description ? `<details><summary>What the task asks</summary><div class="text">${esc(t.description)}</div></details>` : ''}</section>`).join('')}`
    : '';
  const body = `${notice ? `<div class="notice">${esc(notice)}</div>` : ''}<p class="crumbs"><a href="/">Work</a></p><h1>${esc(wi.title)}</h1>
<p class="muted small">${esc(wi.projectId)} · asked by ${esc(wi.requester)} · started ${esc(new Date(wi.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · spent ${money(wi.spentUsd)}${source}</p>
${steps(wi)}
<div class="headline ${h.tone}"><div>${h.needsYou ? `${chip('Needs you', 'wait')} ` : ''}${esc(h.text)}</div>${workItemActions(wi, token)}</div>
${specSection(extras.spec, wi)}
${wi.tasks.length ? `<h2>Tasks</h2>${wi.tasks.map((t) => taskCard(t, wi, !FINISHED.has(wi.state) && taskActions(t, token, false).length ? '<p class="muted small">↑ Your choices for this task are at the top of the page.</p>' : '')).join('')}` : planned}
${storySection(story(wi, events))}
${runsTable(wi, costByRun(events))}
<details class="card"><summary><b>Raw status</b> <span class="muted small">as <code>factory status</code> prints it</span></summary><pre>${esc(description)}</pre></details>`;
  return page(wi.title, body, !notice);
}

export function runPage(runId: string, log: string, view?: Omit<Parameters<typeof runBody>[0], 'runId' | 'events'> & { events: StoredEvent[] }): string {
  if (!view) return page(runId, `<h1>${esc(runId)}</h1><pre>${esc(log)}</pre>`, false);
  return page(runId, runBody({ runId, ...view }, log), false);
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
  const specs = new EventSpecStore(store);
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
        if (!wi) return send(res, 404, page('Not found', '<p>No such work item.</p>', false));
        const events = await store.query({ streamIds: [wi.id] });
        const spec = wi.spec ? await specs.get(wi.spec.specId).catch(() => undefined) : undefined;
        return send(res, 200, workItemPage(wi, describeWorkItem(wi), token, url.searchParams.get('notice') ?? undefined, { events, ...(spec ? { spec } : {}) }));
      }
      const runMatch = /^\/run\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && runMatch) {
        const runId = runMatch[1]!;
        const events = await store.query({ streamIds: [runId] });
        if (!events.length) return send(res, 404, page('Not found', '<p>No such run.</p>', false));
        const ctx = events.find((e) => e.type === 'run_context')?.payload as { workItemId?: string } | undefined;
        const wi = ctx?.workItemId ? await repo.load(ctx.workItemId) : undefined;
        // A run's id is the stream; retried agents within it carry a suffix, and are part of its page.
        const run = wi?.runs.find((r) => r.id === runId);
        const cost = wi ? costByRun(await store.query({ streamIds: [wi.id], types: ['agent_cost_recorded'] })).get(runId) : undefined;
        return send(res, 200, runPage(runId, formatLog(events, { full: true }), { events, ...(wi ? { wi } : {}), ...(run ? { run } : {}), ...(cost !== undefined ? { cost } : {}) }));
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
