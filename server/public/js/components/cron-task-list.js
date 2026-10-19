import { useState } from 'preact/hooks';
import { downloadBlob } from '../api.js';
import { html, Icons, StatusBadge } from '../ui.js';

// ── Cron/Task List Component ─────────────────────────────
export function CronTaskList({ tasks, isWindows, onRefresh, onAction, onRunNow, hostname }) {
  const [expanded, setExpanded] = useState(null);
  const [showSystem, setShowSystem] = useState(false);

  // Filter system tasks for Windows
  const systemPaths = ['\\Microsoft\\', '\\Windows\\', '\\MicrosoftEdge', '\\Mozilla\\', '\\Google\\', '\\Adobe\\'];
  const filtered = isWindows && !showSystem
    ? tasks.filter(t => {
        const path = (t.TaskPath || '').toLowerCase();
        return !systemPaths.some(sp => path.includes(sp.toLowerCase()));
      })
    : tasks;

  return (
    html`<div>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style=${{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style=${{ fontSize: 13, fontWeight: 600 }}>${filtered.length} ${isWindows ? 'Scheduled Tasks' : 'Crons / Timers'}</span>
          ${isWindows && tasks.length !== filtered.length && (
            html`<span style=${{ fontSize: 10, color: 'var(--text-dim)' }}>(${tasks.length - filtered.length} system tasks hidden)</span>`
          )}
        </div>
        <div class="btn-group">
          ${isWindows && (
            html`<button class="btn btn-sm" onClick=${() => setShowSystem(!showSystem)}>
              ${showSystem ? 'Hide System' : 'Show System'}
            </button>`
          )}
          <button class="btn btn-sm" onClick=${onRefresh}><${Icons.RefreshCw}/> Refresh</button>
          <button class="btn btn-sm" onClick=${() => {
            const text = isWindows ? JSON.stringify(tasks, null, 2) : tasks.map(t => t.raw).join('\n');
            downloadBlob(text, `${hostname}-crons.txt`);
          }}><${Icons.Download}/> Download</button>
        </div>
      </div>
      <div style=${{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        ${filtered.map((t, i) => {
          const name = isWindows ? (t.TaskName || t.Name || `Task ${i}`) : (t.name || `Entry ${i}`);
          const isExp = expanded === i;
          const stateReady = isWindows ? (t.State === 'Ready' || t.State === 3 || t.State === 'ready') : (t.type === 'timer');
          return (
            html`<div key=${i} style=${{
              background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6,
              overflow: 'hidden'
            }}>
              <div onClick=${() => setExpanded(isExp ? null : i)} style=${{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer',
                borderLeft: `3px solid ${stateReady ? 'var(--green)' : 'var(--text-dim)'}`
              }}>
                <span style=${{ fontSize: 12, fontWeight: 600, flex: 1, fontFamily: 'Geist Mono, monospace' }}>${name}</span>
                ${isWindows && html`<${StatusBadge} status=${stateReady ? 'online' : 'offline'}/>`}
                ${!isWindows && t.type === 'timer' && html`<span class="badge badge-running"><span class="badge-dot"/>timer</span>`}
                ${!isWindows && t.type === 'cron' && html`<span class="badge badge-pending"><span class="badge-dot"/>cron</span>`}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style=${{
                  width: 14, height: 14, color: 'var(--text-dim)',
                  transform: isExp ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s'
                }}><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              ${isExp && (
                html`<div style=${{ padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)' }}>
                  ${isWindows && (
                    html`
                      <div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Path: </span><span class="mono">${t.TaskPath || ''}</span></div>
                      <div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>State: </span>${t.State}</div>
                      <div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Next Run: </span>${t.NextRun ? new Date(t.NextRun).toLocaleString() : 'N/A'}</div>
                      ${t.LastRun && html`<div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Last Run: </span>${new Date(t.LastRun).toLocaleString()}</div>`}
                      ${t.Description && html`<div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Description: </span>${t.Description}</div>`}
                    `
                  )}
                  ${!isWindows && (
                    html`
                      ${t.schedule && html`<div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Schedule: </span><span class="mono">${t.schedule}</span></div>`}
                      ${t.command && html`<div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Command: </span><span class="mono" style=${{ wordBreak: 'break-all' }}>${t.command}</span></div>`}
                      ${t.details && html`<div style=${{ fontSize: 11, marginBottom: 4 }}><span style=${{ color: 'var(--text-dim)' }}>Details: </span>${t.details}</div>`}
                      <div style=${{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, fontFamily: 'Geist Mono, monospace' }}>${t.raw}</div>
                    `
                  )}
                  <div class="btn-group" style=${{ marginTop: 8 }}>
                    ${onRunNow && (isWindows || (t.type === 'timer')) && (
                      html`<button class="btn btn-sm btn-primary" onClick=${(e) => { e.stopPropagation(); onRunNow(isWindows ? (t.TaskPath || '') + (t.TaskName || '') : t.name); }}>
                        <${Icons.Play}/> Run Now
                      </button>`
                    )}
                    ${onAction && isWindows && (
                      html`
                        <button class="btn btn-sm" onClick=${(e) => { e.stopPropagation(); onAction(t.TaskPath ? t.TaskPath + t.TaskName : t.TaskName, 'enable'); }}>Enable</button>
                        <button class="btn btn-sm" onClick=${(e) => { e.stopPropagation(); onAction(t.TaskPath ? t.TaskPath + t.TaskName : t.TaskName, 'disable'); }}>Disable</button>
                      `
                    )}
                    ${onAction && !isWindows && t.type === 'timer' && (
                      html`
                        <button class="btn btn-sm" onClick=${(e) => { e.stopPropagation(); onAction(t.name, 'start'); }}>Start</button>
                        <button class="btn btn-sm" onClick=${(e) => { e.stopPropagation(); onAction(t.name, 'stop'); }}>Stop</button>
                        <button class="btn btn-sm" onClick=${(e) => { e.stopPropagation(); onAction(t.name, 'restart'); }}>Restart</button>
                      `
                    )}
                  </div>
                </div>`
              )}
            </div>`
          );
        })}
      </div>
    </div>`
  );
}
