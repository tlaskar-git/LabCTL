have fail2ban-client || die "fail2ban is not installed"
step "Service"
say "active: $(systemctl is-active fail2ban 2>&1 || true)"
step "Jails"
JAILS="$(fail2ban-client status | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ' ' | tr ',' ' ')"
TOTAL=0
for j in $JAILS; do
  OUT="$(fail2ban-client status "$j")"
  NOW="$(printf '%s\n' "$OUT" | sed -n 's/.*Currently banned:[[:space:]]*//p')"
  EVER="$(printf '%s\n' "$OUT" | sed -n 's/.*Total banned:[[:space:]]*//p')"
  say "$j: banned now $NOW, banned in total $EVER"
  TOTAL=$(( TOTAL + ${NOW:-0} ))
done
say "Currently banned across all jails: $TOTAL"
result fail2ban_banned "$TOTAL"
