import { useState, useEffect } from 'preact/hooks';
import { api, apiDownload } from '../api.js';
import { html, Icons } from '../ui.js';

export default function AgentsPage({ addToast }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { api('/api/agents/info').then(setInfo).catch(e => addToast(e.message, 'error')); }, []);
  const download = async (file) => {
    try { await apiDownload(file.path, file.path.split('/').pop()); } catch (e) { addToast(e.message, 'error'); }
  };
  const ws = info?.server_url || 'ws://YOUR_SERVER_IP:7700/ws/agent';
  return (
    html`<div>
      <div class="page-header"><div><div class="page-title">Agent Downloads</div><div class="page-desc">Install agents on Linux and Windows hosts.</div></div></div>
      <div class="metric-grid">
        ${(info?.files || []).map(f => (
          html`<div class="metric-card" key=${f.id}>
            <div class="card-title">${f.label}</div>
            <button class="btn btn-primary" style=${{ marginTop: 12 }} onClick=${() => download(f)}><${Icons.Download}/> Download</button>
          </div>`
        ))}
      </div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>Linux</div>
        <div class="copy-block"><code>chmod +x setup-linux.sh && sudo ./setup-linux.sh ${ws}</code></div>
      </div>
      <div class="card">
        <div class="card-title" style=${{ marginBottom: 12 }}>Windows PowerShell as Administrator</div>
        <div class="copy-block"><code>Set-ExecutionPolicy Bypass -Scope Process -Force; .\\setup-windows.ps1 -ServerUrl "${ws}"</code></div>
      </div>
    </div>`
  );
}
