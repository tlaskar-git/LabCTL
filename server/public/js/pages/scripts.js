import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';

export default function ScriptsPage({ hosts, addToast }) {
  const [scripts, setScripts] = useState([]);
  const [form, setForm] = useState({ name: '', description: '', os: 'any', target: 'host', command: '', timeout: 300 });
  const [selected, setSelected] = useState('');
  const [hostIds, setHostIds] = useState([]);
  const [container, setContainer] = useState('');
  const selectedScript = scripts.find(s => s.id === selected);

  const load = async () => { try { setScripts(await api('/api/scripts')); } catch (e) { addToast(e.message, 'error'); } };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api('/api/scripts', { method: 'POST', body: form });
      setForm({ name: '', description: '', os: 'any', target: 'host', command: '', timeout: 300 });
      load(); addToast('Script saved');
    } catch (e) { addToast(e.message, 'error'); }
  };
  const run = async (script) => {
    try {
      const res = await api(`/api/scripts/${script.id}/run`, { method: 'POST', body: { host_ids: hostIds, container } });
      addToast(`Queued ${res.filter(r => r.job_id).length} job(s)`);
    } catch (e) { addToast(e.message, 'error'); }
  };

  return (
    html`<div>
      <div class="page-header">
        <div><div class="page-title">Scripts & Jobs</div><div class="page-desc">Save repeatable host or Docker-container commands.</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">New script</div></div>
        <div class="form-row">
          <input class="input" placeholder="Name" value=${form.name} onInput=${e => setForm({ ...form, name: e.target.value })}/>
          <select class="select" value=${form.os} onChange=${e => setForm({ ...form, os: e.target.value })}><option value="any">Any OS</option><option value="linux">Linux</option><option value="windows">Windows</option></select>
          <select class="select" value=${form.target} onChange=${e => setForm({ ...form, target: e.target.value })}><option value="host">Host</option><option value="container">Docker container</option></select>
        </div>
        <input class="input" style=${{ marginBottom: 12 }} placeholder="Description" value=${form.description} onInput=${e => setForm({ ...form, description: e.target.value })}/>
        <textarea class="textarea script-editor" placeholder="Command or script body" value=${form.command} onInput=${e => setForm({ ...form, command: e.target.value })}/>
        <div class="form-row" style=${{ marginTop: 12 }}>
          <div class="form-group"><label class="form-label">Timeout seconds</label><input class="input" type="number" value=${form.timeout} onInput=${e => setForm({ ...form, timeout: e.target.value })}/></div>
          <div style=${{ alignSelf: 'end' }}><button class="btn btn-primary" onClick=${create}><${Icons.Play}/> Save script</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Run saved script</div></div>
        <div class="form-row">
          <select class="select" value=${selected} onChange=${e => setSelected(e.target.value)}>
            <option value="">Choose script</option>
            ${scripts.map(s => html`<option key=${s.id} value=${s.id}>${s.name}</option>`)}
          </select>
          <input class="input" placeholder="Container name, if needed" value=${container} onInput=${e => setContainer(e.target.value)}/>
        </div>
        ${selectedScript && (
          html`<div class="script-preview">
            <div class="script-preview-head">
              <div>
                <div class="card-title">${selectedScript.name}</div>
                <div class="page-desc">${selectedScript.description || 'No description saved.'}</div>
              </div>
              <div class="btn-group">
                <span class="badge">${selectedScript.os}</span>
                <span class="badge">${selectedScript.target}</span>
              </div>
            </div>
            <div class="output-log" style=${{ maxHeight: 260 }}>${selectedScript.command}</div>
          </div>`
        )}
        <div class="hosts-grid">
          ${hosts.map(h => (
            html`<label key=${h.id} class="host-card">
              <input type="checkbox" checked=${hostIds.includes(h.id)} onChange=${e => setHostIds(e.target.checked ? [...hostIds, h.id] : hostIds.filter(id => id !== h.id))}/> ${h.hostname}
              <div class="host-os">${h.os}</div>
            </label>`
          ))}
        </div>
        <button class="btn btn-primary" disabled=${!selectedScript || !hostIds.length} onClick=${() => run(selectedScript)}><${Icons.Play}/> Queue job</button>
      </div>
    </div>`
  );
}
