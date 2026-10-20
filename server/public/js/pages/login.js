import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';

export default function LoginPage({ onLogin, addToast }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef(null);
  useEffect(() => { passwordRef.current && passwordRef.current.focus(); }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: form });
      localStorage.setItem('labctl_token', res.token);
      onLogin(res.user);
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    html`<div class="login-shell">
      <form class="card login-panel" onSubmit=${submit}>
        <div class="login-brand">
          <img src="/labctl-logo.svg" alt="LabCTL"/>
        </div>
        <div class="form-group" style=${{ marginBottom: 12 }}>
          <label class="form-label">User</label>
          <input class="input" value=${form.username} onInput=${e => setForm({ ...form, username: e.target.value })}/>
        </div>
        <div class="form-group" style=${{ marginBottom: 16 }}>
          <label class="form-label">Password</label>
          <input class="input" type="password" value=${form.password} onInput=${e => setForm({ ...form, password: e.target.value })} ref=${passwordRef}/>
        </div>
        <button class="btn btn-primary" style=${{ width: '100%', justifyContent: 'center' }} disabled=${busy}>
          <${Icons.Key}/> ${busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>`
  );
}
