import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { html, Icons } from '../ui.js';

export default function UsersPage({ addToast }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'readonly' });
  const load = async () => { try { setUsers(await api('/api/users')); } catch (e) { addToast(e.message, 'error'); } };
  useEffect(() => { load(); }, []);
  const create = async () => {
    try {
      await api('/api/users', { method: 'POST', body: form });
      setForm({ username: '', password: '', role: 'readonly' });
      load(); addToast('User created');
    } catch (e) { addToast(e.message, 'error'); }
  };
  const remove = async (id) => {
    try { await api(`/api/users/${id}`, { method: 'DELETE' }); load(); addToast('User removed'); }
    catch (e) { addToast(e.message, 'error'); }
  };
  return (
    html`<div>
      <div class="page-header"><div><div class="page-title">Local Users</div><div class="page-desc">Create admin and readonly accounts.</div></div></div>
      <div class="card">
        <div class="form-row">
          <input class="input" placeholder="Username" value=${form.username} onInput=${e => setForm({ ...form, username: e.target.value })}/>
          <input class="input" type="password" placeholder="Password" value=${form.password} onInput=${e => setForm({ ...form, password: e.target.value })}/>
          <select class="select" value=${form.role} onChange=${e => setForm({ ...form, role: e.target.value })}><option value="readonly">Readonly</option><option value="admin">Admin</option></select>
          <button class="btn btn-primary" onClick=${create}><${Icons.User}/> Create</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Role</th><th>Created</th><th></th></tr></thead>
            <tbody>${users.map(u => html`<tr key=${u.id}><td>${u.username}</td><td>${u.role}</td><td class="mono">${u.created_at?.slice(0, 19)}</td><td><button class="btn btn-sm btn-danger" onClick=${() => remove(u.id)}><${Icons.Trash}/></button></td></tr>`)}</tbody>
          </table>
        </div>
      </div>
    </div>`
  );
}
