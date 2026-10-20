#!/bin/bash
# LabCTL deploy relay. Runs as a job on an online LabCTL agent and reaches the target over ssh from there.
# Input arrives in the job environment. Secrets are LABCTL_SECRET_* (PASSWORD, KEY, PASSPHRASE, SUDO, TOKEN) and are
# never written to the command line. The password and the passphrase reach ssh through an SSH_ASKPASS helper that
# reads them from the environment (needs OpenSSH 8.4 or newer). A private key is written to a 0600 file in a 0700
# temp folder that is removed on exit. Host keys are accepted on first use for this run only.
# Other input: T_MODE (probe|install|uninstall), T_ADDR, T_PORT, T_USER, T_PROBE, T_CMD, T_DIR, T_SUDO (1|0),
# T_SERVER, T_FILES ("remote-name:local-name ..."), T_UNINSTALL (optional script text).
set -u
d=$(mktemp -d) || exit 1
chmod 700 "$d"
trap 'rm -rf "$d"' EXIT

ssh_opts=(-p "$T_PORT" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$d/known_hosts" -o ConnectTimeout=10 -o LogLevel=ERROR)
if [ -n "${LABCTL_SECRET_KEY:-}" ]; then
  printf '%s\n' "$LABCTL_SECRET_KEY" > "$d/key"
  chmod 600 "$d/key"
  ssh_opts+=(-i "$d/key" -o IdentitiesOnly=yes -o PasswordAuthentication=no)
else
  ssh_opts+=(-o PubkeyAuthentication=no)
fi
if [ -n "${LABCTL_SECRET_KEY:-}" ] && [ -z "${LABCTL_SECRET_PASSPHRASE:-}" ]; then
  ssh_opts+=(-o BatchMode=yes)
else
  cat > "$d/askpass" <<'ASK'
#!/bin/sh
if [ -n "${LABCTL_SECRET_PASSPHRASE:-}" ]; then printf '%s\n' "$LABCTL_SECRET_PASSPHRASE"; else printf '%s\n' "${LABCTL_SECRET_PASSWORD:-}"; fi
ASK
  chmod 700 "$d/askpass"
  export SSH_ASKPASS="$d/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-labctl}"
fi
remote() { ssh "${ssh_opts[@]}" "$T_USER@$T_ADDR" "$@"; }

case "$T_MODE" in
  probe)
    printf '%s\n' "$T_PROBE" > "$d/probe.sh"
    out=$(remote 'sh -s' < "$d/probe.sh" 2> "$d/err")
    rc=$?
    if [ "$rc" -ne 0 ]; then echo "ssh_error=$(tr '\n' ' ' < "$d/err" | cut -c1-300)"; exit 0; fi
    printf '%s\n' "$out"
    if printf '%s\n' "$out" | grep -qx 'sudo=password' && [ -n "${LABCTL_SECRET_SUDO:-}" ]; then
      if printf '%s\n' "$LABCTL_SECRET_SUDO" | remote "sudo -S -p '' -v" > /dev/null 2>&1; then echo sudo_verify=ok; else echo sudo_verify=fail; fi
    fi
    ;;
  install|uninstall)
    stage="$d/stage"
    mkdir "$stage"
    printf 'Authorization: Bearer %s\n' "$LABCTL_SECRET_TOKEN" > "$d/hdr"
    for f in ${T_FILES:-}; do
      curl -fsS -H "@$d/hdr" -o "$stage/${f#*:}" "$T_SERVER/install/${f%%:*}" || { echo "The relay cannot download ${f%%:*} from the LabCTL server"; exit 1; }
    done
    printf 'SERVER_URL=%q\nTOKEN=%q\n' "$T_SERVER" "$LABCTL_SECRET_TOKEN" > "$stage/deploy.env"
    [ -n "${T_UNINSTALL:-}" ] && printf '%s\n' "$T_UNINSTALL" > "$stage/uninstall.sh"
    echo "Uploading the setup files to $T_DIR on $T_ADDR through the relay"
    tar -C "$stage" -cf - . | remote "mkdir -m 700 $T_DIR && tar -xf - -C $T_DIR" || { echo "Upload through the relay failed"; exit 1; }
    if [ "$T_SUDO" = 1 ]; then printf '%s\n' "${LABCTL_SECRET_SUDO:-}" | remote "$T_CMD"; else remote "$T_CMD" < /dev/null; fi
    rc=$?
    remote "rm -rf $T_DIR" < /dev/null > /dev/null 2>&1
    exit "$rc"
    ;;
  *) echo "unknown mode"; exit 2 ;;
esac
