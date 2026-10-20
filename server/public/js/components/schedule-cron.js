import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html } from '../ui.js';
import { Segmented, absTime } from './ui-kit.js';

// Run times read in the server timezone, which is the one the cron uses.
const inZone = (iso, tz) => { try { return new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }); } catch { return absTime(iso); } };

// A friendly cron editor: daily, weekly (days of the week), monthly (day of the month) or raw cron, plus the time.
// Shows the next three runs from the server (cron-parser in the server timezone setting).
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');

export function parseCron(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  const ok = f.length === 5 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[3] === '*';
  const time = ok ? `${pad(f[1])}:${pad(f[0])}` : '02:00';
  if (ok && f[2] === '*' && f[4] === '*') return { mode: 'daily', time, days: [1], dom: 1 };
  if (ok && f[2] === '*' && /^[0-6](,[0-6])*$/.test(f[4])) return { mode: 'weekly', time, days: f[4].split(',').map(Number), dom: 1 };
  if (ok && /^\d+$/.test(f[2]) && f[4] === '*') return { mode: 'monthly', time, days: [1], dom: Number(f[2]) };
  return { mode: 'cron', time, days: [1], dom: 1 };
}

export function buildCron({ mode, time, days, dom }) {
  const [h, m] = String(time || '02:00').split(':').map(Number);
  if (mode === 'daily') return `${m} ${h} * * *`;
  if (mode === 'weekly') return `${m} ${h} * * ${[...days].sort((a, b) => a - b).join(',') || '1'}`;
  return `${m} ${h} ${dom} * *`;
}

export function CronField({ value, onChange, id = 'cron' }) {
  const [form, setForm] = useState(() => parseCron(value));
  const [prev, setPrev] = useState({ runs: [], error: '' });
  const set = change => {
    const next = { ...form, ...change };
    setForm(next);
    if (next.mode !== 'cron') onChange(buildCron(next));
  };
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/builtin-schedules/preview?cron=${encodeURIComponent(value || '')}`)
        .then(r => setPrev({ runs: r.runs, tz: r.timezone, error: '' }), e => setPrev({ runs: [], error: e.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [value]);

  return html`<div class="sched-cron">
    <${Segmented} label="How often" value=${form.mode} onChange=${mode => set({ mode })}
      options=${[['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['cron', 'Cron']]}/>
    <div class="sched-cron-fields">
      ${form.mode !== 'cron' && html`<div class="form-group">
        <label class="form-label" for=${`${id}-time`}>Time</label>
        <input id=${`${id}-time`} class="input" type="time" value=${form.time} onInput=${e => e.target.value && set({ time: e.target.value })}/>
      </div>`}
      ${form.mode === 'monthly' && html`<div class="form-group">
        <label class="form-label" for=${`${id}-dom`}>Day of the month</label>
        <input id=${`${id}-dom`} class="input" type="number" min="1" max="28" value=${form.dom}
          onInput=${e => { const d = Math.min(28, Math.max(1, Number(e.target.value) || 1)); set({ dom: d }); }}/>
      </div>`}
      ${form.mode === 'cron' && html`<div class="form-group">
        <label class="form-label" for=${`${id}-raw`}>Cron expression</label>
        <input id=${`${id}-raw`} class="input mono" value=${value} placeholder="0 2 * * 1" aria-describedby=${`${id}-help`}
          onInput=${e => onChange(e.target.value)}/>
        <div class="hint" id=${`${id}-help`}>Five fields: minute, hour, day of the month, month, day of the week.</div>
      </div>`}
    </div>
    ${form.mode === 'weekly' && html`<div class="sched-days" role="group" aria-label="Days of the week">
      ${DAYS.map((d, i) => html`<button key=${d} type="button" class="sched-day" aria-pressed=${form.days.includes(i) ? 'true' : 'false'}
        onClick=${() => { const days = form.days.includes(i) ? form.days.filter(x => x !== i) : [...form.days, i]; if (days.length) set({ days }); }}>${d}</button>`)}
    </div>`}
    <div class="sched-preview" aria-live="polite">
      ${prev.error ? html`<span class="sched-error">${prev.error}</span>`
        : html`<span class="hint">Next runs${prev.tz ? ` (${prev.tz})` : ''}: </span>${prev.runs.map((r, i) => html`<span key=${r} class="sched-run">${inZone(r, prev.tz)}${i < prev.runs.length - 1 ? ',' : ''}</span>`)}`}
      <code class="sched-code">${value}</code>
    </div>
  </div>`;
}
