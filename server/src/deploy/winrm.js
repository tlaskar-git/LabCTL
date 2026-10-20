// WinRM client for Windows targets, on top of the winrm-client package (pure JavaScript, NTLM built in, no native code).
// One remote shell is reused for every command of a deploy. Scripts travel as -EncodedCommand, so quoting never matters.
// Limits: over HTTP (5985) the target must allow unencrypted WinRM, because this client does NTLM sign-in without message
// encryption. Use HTTPS (5986) where possible. Certificates are not verified on 5986 (targets use self-signed ones).
const explain = (err, t) => {
  const m = String(err.message || err);
  if (/401|Unauthorized|authenticat|logon/i.test(m)) return `WinRM rejected the sign-in for ${t.user} on ${t.address}. Check the user name and password. Over HTTP (5985) the target must also allow unencrypted WinRM.`;
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(m)) return `Connection refused on ${t.address}:${t.port}. Is WinRM enabled (winrm quickconfig)?`;
  if (err.code === 'ETIMEDOUT' || /timed out|ETIMEDOUT/i.test(m)) return `Timed out connecting to ${t.address}:${t.port}.`;
  if (/unencrypted/i.test(m)) return 'WinRM refused unencrypted traffic. Use port 5986 (HTTPS) or allow unencrypted WinRM on the target.';
  return m;
};

// A failed PowerShell command returns its error stream as CLIXML. Show the text parts only.
const cleanErr = s => (/#< CLIXML/.test(s)
  ? [...s.matchAll(/<S S="Error">(.*?)<\/S>/g)].map(m => m[1].replace(/_x000D__x000A_/g, ' ').replace(/_x[0-9A-F]{4}_/g, '')).join(' ').trim()
  : s);

// lib is injectable for tests. Resolves { run(script) -> stdout text, close() }.
async function open(t, lib = require('winrm-client')) {
  const params = { host: t.address, port: t.port, path: '/wsman', authMethod: 'ntlm', useHttps: t.port === 5986, rejectUnauthorized: false,
    username: /[\\@]/.test(t.user) ? t.user : `.\\${t.user}`, password: t.password };
  let shellId;
  try { shellId = await lib.Shell.doCreateShell(params); } catch (e) { throw new Error(explain(e, t)); }
  const p = { ...params, shellId };
  return {
    async run(script) {
      try {
        const command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
        const commandId = await lib.Command.doExecuteCommand({ ...p, command });
        return cleanErr(await lib.Command.doReceiveOutput({ ...p, command, commandId }));
      } catch (e) { throw new Error(explain(e, t)); }
    },
    close: () => Promise.resolve(lib.Shell.doDeleteShell(p)).catch(() => {})
  };
}

module.exports = { open, explain, cleanErr };
