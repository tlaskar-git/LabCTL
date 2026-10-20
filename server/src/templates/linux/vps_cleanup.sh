need_root
DAYS="${LABCTL_P_JOURNAL_DAYS:-14}"; need_int JOURNAL_DAYS "$DAYS"
MAXMB="${LABCTL_P_JOURNAL_MAX_MB:-500}"; need_int JOURNAL_MAX_MB "$MAXMB"
BEFORE="$(free_kb /)"
step "Journal (keep $DAYS days, at most $MAXMB MB)"
journalctl --disk-usage 2>/dev/null || true
run journalctl --vacuum-time="${DAYS}d"
run journalctl --vacuum-size="${MAXMB}M"
if have apt-get; then
  step "apt"
  run apt-get -y autoremove --purge
  run apt-get clean
fi
AFTER="$(free_kb /)"
say "Space freed: $(( (AFTER - BEFORE) / 1024 )) MB (free now $(( AFTER / 1048576 )) GB)"
