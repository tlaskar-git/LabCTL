# Disk Cleanup, as v1: OPTIONS picks from apt_cache, journal, docker_prune, tmp (empty runs all four), then df -h.
for o in $(list_of "${LABCTL_P_OPTIONS:-}"); do
  case "$o" in apt_cache|journal|docker_prune|tmp) ;; *) echo "Option $o is not available for this host, skipped." ;; esac
done
if has_opt apt_cache; then
  echo "APT cleanup:"
  if have apt-get; then apt-get autoremove -y 2>&1 && apt-get autoclean -y 2>&1; else echo "apt-get is not available"; fi
fi
if has_opt journal; then
  echo "Journal vacuum:"
  if have journalctl; then journalctl --vacuum-time=7d 2>&1; else echo "journalctl is not available"; fi
fi
if has_opt docker_prune; then
  echo "Docker prune:"
  if have docker; then docker system prune -f 2>&1; else echo "Docker not available"; fi
fi
if has_opt tmp; then
  # The running job lives in /tmp/labctl-job-*, so those folders stay.
  find /tmp -mindepth 1 -maxdepth 1 ! -name 'labctl-job-*' -exec rm -rf -- {} + 2>&1 || true
  echo "Temp files cleared"
fi
echo
echo "Disk space:"
df -h 2>&1
exit 0
