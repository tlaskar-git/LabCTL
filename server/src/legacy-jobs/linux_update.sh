# Linux Update: refresh and upgrade every package without prompts (apt-get, dnf, yum or zypper), then optionally
# schedule a reboot when the system says one is needed.
export DEBIAN_FRONTEND=noninteractive
echo "Updating packages on $(hostname)"
if have apt-get; then
  apt-get update 2>&1 &&
    apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade -y 2>&1 &&
    apt-get autoremove -y 2>&1
  rc=$?
elif have dnf; then
  dnf -y upgrade 2>&1; rc=$?
elif have yum; then
  yum -y update 2>&1; rc=$?
elif have zypper; then
  zypper --non-interactive refresh 2>&1 && zypper --non-interactive update 2>&1; rc=$?
else
  die "No supported package manager found (apt-get, dnf, yum or zypper)."
fi
if [ "$rc" = 0 ] && truthy "${LABCTL_P_REBOOT:-0}"; then
  needed=0
  [ -f /var/run/reboot-required ] && needed=1
  if [ "$needed" = 0 ] && have needs-restarting; then needs-restarting -r >/dev/null 2>&1 || needed=1; fi
  if [ "$needed" = 1 ]; then shutdown -r +1 "LabCTL: Rebooting after updates" 2>&1 && echo "Reboot scheduled in 1 minute."
  else echo "No reboot needed."; fi
fi
exit "$rc"
