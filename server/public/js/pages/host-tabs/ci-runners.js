import { html } from '../../ui.js';
import { useHostRunners, githubColumns } from '../../components/runner-status.js';
import { AddRunnerButton } from '../../components/runner-actions.js';
import { InventoryGate, Section, DataTable, LogBox, KV, toneBadge, fmtBytes, arr } from '../../components/chart-kit.js';

// Props: host (record from the hosts list, may be undefined), hostId, addToast.
// Renders inventory.runners from the agent: service state, version, busy flag, job, sizes, log tail, run-as account.
// GitHub columns (status, busy flag, labels, queued runs, warnings, actions) come from components/runner-status.js.

const serviceOk = r => ['active', 'running', 'started'].includes(String(r.service_state || '').toLowerCase());

export default function CiRunnersTab({ host, hostId, addToast }) {
  const gh = useHostRunners(hostId);
  const hostName = (host && host.hostname) || hostId;
  const ctl = { hostId, hostName, github: gh.github, onChange: gh.reload, addToast: addToast || (() => {}) };
  return html`<${InventoryGate} hostId=${hostId}>${inv => {
    const runners = arr(inv.runners);
    return html`<div>
      <${Section} title=${`GitHub Actions runners (${runners.length})`} right=${html`<${AddRunnerButton} hostId=${hostId} hostName=${hostName} onDone=${gh.reload} addToast=${ctl.addToast}/>`}>
        <${DataTable} empty="No runners found on this host" rows=${runners} cols=${[
          { h: 'Runner', f: r => r.name || r.path },
          { h: 'Scope', f: r => [r.level, r.pool].filter(Boolean).join(' / ') || '-' },
          { h: 'Service', f: r => toneBadge(serviceOk(r) ? 'ok' : 'bad', r.service_state || 'not installed') },
          { h: 'Run as', f: r => r.run_as || '-' },
          { h: 'Version', f: r => r.version || '-' },
          { h: 'State', f: r => (r.busy ? toneBadge('warn', `Busy${r.job ? `: ${r.job}` : ''}`) : 'Idle') },
          { h: 'Work', num: true, f: r => fmtBytes(r.sizes?.work) }, { h: 'Diag', num: true, f: r => fmtBytes(r.sizes?.diag) },
          { h: 'Temp', num: true, f: r => fmtBytes(r.sizes?.temp) }, { h: 'Tool cache', num: true, f: r => fmtBytes(r.sizes?.tool_cache) },
          ...githubColumns(r => gh.byName[r.name], ctl)]}/>
      <//>
      ${runners.map(r => html`<${Section} key=${r.path} title=${`${r.name || r.path} log tail`}>
        <${KV} rows=${[['Folder', r.path], ['Service unit', r.service ?? null], ['Source', r.source ?? null], ['Labels', arr(r.labels).join(', ') || null],
          ['Registered at', r.url ?? null], ['Sizes complete', r.sizes_partial ? 'No, the scan hit its time limit' : undefined]]}/>
        <div style=${{ height: 10 }}/>
        <${LogBox} lines=${arr(r.log_tail)}/>
      <//>`)}
    </div>`;
  }}<//>`;
}
