import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { Chip, EmptyState, KitIcons, Skeleton, absTime, clockTime, groupByDay, nameFor } from '../components/ui-kit.js';

// Audit log from GET /api/audit (newest first, already redacted by the server). Grouped by day, details behind a click.
const PAGE = 100;
const tone = a => (/delete|remove|revoke|uninstall|fail/.test(a) ? 'bad' : /update|rotate|apply|reboot|run|restart/.test(a) ? 'warn' : /login|auth/.test(a) ? 'info' : 'muted');
const summary = d => (d && typeof d === 'object' ? Object.entries(d).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ') : '');

export default function AuditPage({ hosts = [] }) {
  const [f, setF] = useState({ actor: '', action: '', since: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = offset => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (f.actor.trim()) p.set('actor', f.actor.trim());
    if (f.action.trim()) p.set('action', f.action.trim());
    if (f.since) p.set('since', `${f.since}T00:00:00.000Z`);
    return api(`/api/audit?${p}`);
  };
  useEffect(() => {
    const t = setTimeout(() => query(0).then(r => { setData(r); setError(''); }, e => setError(e.message)), 250);
    return () => clearTimeout(t);
  }, [f.actor, f.action, f.since]);
  const more = async () => {
    setBusy(true);
    try { const r = await query(data.rows.length); setData(d => ({ ...r, rows: [...d.rows, ...r.rows] })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const hostName = id => nameFor(hosts, id);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));

  return html`<div>
    <div class="page-header"><div><div class="page-title">Audit log</div>
      <div class="page-desc">${data ? `${data.total} entries. Secrets are removed before they are stored.` : 'Who did what, and when.'}</div></div></div>
    <div class="filter-bar" role="search">
      <input class="input" placeholder="User" aria-label="Filter by user" value=${f.actor} onInput=${set('actor')}/>
      <input class="input grow" placeholder="Action contains, for example hosts.remove" aria-label="Filter by action" value=${f.action} onInput=${set('action')}/>
      <input class="input" type="date" aria-label="From date" value=${f.since} onInput=${set('since')}/>
    </div>
    ${error && html`<div class="callout bad" style=${{ marginBottom: 12 }}><${KitIcons.Alert}/><div>${error}</div></div>`}
    ${!data ? (!error && html`<${Skeleton} rows=${6}/>`)
      : !data.rows.length ? html`<${EmptyState} icon="List" title="No entries" text=${f.actor || f.action || f.since ? 'Nothing matches these filters.' : 'Every change made through LabCTL is recorded here.'}/>`
      : html`${groupByDay(data.rows, 'ts').map(([day, rows]) => html`<div key=${day}>
          <div class="day-head">${day}</div>
          <div class="rows">${rows.map(r => html`<details class="row audit-row" key=${r.id}>
            <summary>
              <span class="row-meta audit-time" title=${absTime(r.ts)}>${clockTime(r.ts)}</span>
              <span class="row-main"><span class="row-title"><${Chip} tone=${tone(r.action)}>${r.action}<//> <span class="audit-actor">${r.actor}</span></span>
                <span class="row-sub">${[r.host_id && `on ${hostName(r.host_id)}`, summary(r.detail)].filter(Boolean).join(' · ') || ' '}</span></span>
              <span class="audit-more" aria-hidden="true"><${KitIcons.Chevron}/></span>
            </summary>
            <dl class="audit-detail">
              <div><dt>When</dt><dd>${absTime(r.ts)}</dd></div>
              ${r.ip && html`<div><dt>Address</dt><dd class="mono">${r.ip}</dd></div>`}
              ${r.host_id && html`<div><dt>Host</dt><dd><a href=${`#/host/${encodeURIComponent(r.host_id)}`}>${hostName(r.host_id)}</a></dd></div>`}
              <div class="wide"><dt>Detail</dt><dd><pre class="notes">${r.detail ? JSON.stringify(r.detail, null, 2) : 'None'}</pre></dd></div>
            </dl>
          </details>`)}</div>
        </div>`)}
        ${data.rows.length < data.total && html`<button class="btn" style=${{ marginTop: 14 }} disabled=${busy} onClick=${more}>
          ${busy ? 'Loading' : `Show ${Math.min(PAGE, data.total - data.rows.length)} more`}</button>`}`}
  </div>`;
}
