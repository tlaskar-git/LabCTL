// A realistic inventory.data payload (schema 2) for tests and manual runs. Placeholders only. Not a test file.
// Overrides are shallow-merged: inventory({ disks: [...] }).
function inventory(over = {}) {
  const GB = 1024 ** 3;
  return {
    schema: 2, agent_version: '2.0.0', os: 'linux', hostname: 'alpha.example.test', errors: { smart: 'smartctl not installed' },
    os_info: { name: 'Debian GNU/Linux', version: '12', build: null, kernel: '6.1.0-example', arch: 'x86_64', model: null,
      domain: null, ip: '192.0.2.10', boot_time: '2026-10-01T06:00:00Z', uptime_s: 1728000 },
    cpu: { count: 8, percent: 23.5, load: [0.42, 0.51, 0.6] },
    memory: { total: 16 * GB, used: 6 * GB, available: 10 * GB, percent: 37.5, swap_total: 2 * GB, swap_used: GB / 4, swap_percent: 12.5 },
    disks: [
      { device: '/dev/sda1', mount: '/', fstype: 'ext4', total: 100 * GB, used: 62 * GB, free: 38 * GB, percent: 62, inodes_total: 6553600, inodes_used: 400000, inodes_percent: 6 },
      { device: '/dev/sdb1', mount: '/data', fstype: 'ext4', total: 500 * GB, used: 430 * GB, free: 70 * GB, percent: 86, inodes_total: 32000000, inodes_used: 9000000, inodes_percent: 28 }
    ],
    net: [
      { iface: 'lo', rx_bytes: 1000, tx_bytes: 1000, rx_bytes_per_s: 10, tx_bytes_per_s: 10 },
      { iface: 'eth0', rx_bytes: 9e9, tx_bytes: 4e9, rx_bytes_per_s: 120000, tx_bytes_per_s: 45000 }
    ],
    temps: [{ sensor: 'coretemp Package id 0', celsius: 54 }, { sensor: 'nvme Composite', celsius: 41 }],
    smart: [{ device: '/dev/sda', health: 'ok', detail: 'PASSED' }, { device: '/dev/sdb', health: 'failing', detail: 'Reallocated sectors rising' }],
    procs: {
      top_cpu: [{ pid: 811, user: 'root', name: 'dockerd', cpu: 12.3, mem_percent: 2.1, rss: 340000000 }, { pid: 2210, user: 'app', name: 'node', cpu: 8.8, mem_percent: 3.4, rss: 560000000 }],
      top_mem: [{ pid: 2210, user: 'app', name: 'node', cpu: 8.8, mem_percent: 3.4, rss: 560000000 }, { pid: 811, user: 'root', name: 'dockerd', cpu: 12.3, mem_percent: 2.1, rss: 340000000 }]
    },
    services: { failed: [{ name: 'example-sync.service', state: 'failed', detail: 'Main process exited, code=exited, status=1' }] },
    updates: { pending: 7, security: 2, restart_required: true, reboot_required: true, reboot_pending_days: 4,
      last_patch: '2026-08-20T03:00:00Z', items: ['openssl', 'curl'] },
    time: { drift_s: 0.8, source: 'chrony', synced: true },
    docker: { running: 2, total: 3, containers: [
      { id: 'a1b2c3', name: 'web', image: 'example/web:1.4', state: 'running', status: 'Up 3 days (healthy)', health: 'healthy', restart_count: 0,
        cpu_percent: 1.2, mem_bytes: 120000000, mem_percent: 0.7, image_created: '2026-09-01T00:00:00Z', image_age_days: 49, repo_digests: [], newer_image: null },
      { id: 'd4e5f6', name: 'db', image: 'example/db:16', state: 'running', status: 'Up 3 days (unhealthy)', health: 'unhealthy', restart_count: 3,
        cpu_percent: 4.5, mem_bytes: 900000000, mem_percent: 5.2, image_created: '2026-03-01T00:00:00Z', image_age_days: 233, repo_digests: [], newer_image: true },
      { id: '778899', name: 'old', image: 'example/old:0.1', state: 'exited', status: 'Exited (1) 2 days ago', health: null, restart_count: 9,
        cpu_percent: 0, mem_bytes: 0, mem_percent: 0, image_created: '2025-01-01T00:00:00Z', image_age_days: 657, repo_digests: [], newer_image: null }
    ] },
    security: { firewall: { enabled: true, backend: 'nftables' } },
    runners: [
      { path: '/opt/runner-a', name: 'runner-a', url: 'https://github.example.test/example-org/repo', pool: 'default', level: 'repo', labels: ['self-hosted', 'linux'],
        service: 'actions.runner.example-org-repo.runner-a.service', service_state: 'active', run_as: 'runner', source: 'systemd', version: '2.329.0', busy: true, job: 'build (push)',
        sizes: { work: 3 * GB, diag: 12e6, temp: 1e6, tool_cache: 2 * GB }, sizes_partial: false,
        log_tail: ['[2026-10-20 09:00:01Z INFO Runner] Listening for Jobs', '[2026-10-20 09:05:11Z ERROR Worker] Step failed: exit code 1'] },
      { path: '/opt/runner-b', name: 'runner-b', url: 'https://github.example.test/example-org', pool: 'default', level: 'org', labels: ['self-hosted'],
        service: 'actions.runner.example-org.runner-b.service', service_state: 'inactive', run_as: 'runner', source: 'systemd', version: '2.328.0', busy: false, job: null,
        sizes: { work: 1e9, diag: 1e6, temp: 0, tool_cache: 0 }, sizes_partial: true, log_tail: [] }
    ],
    ...over
  };
}

module.exports = { inventory };
