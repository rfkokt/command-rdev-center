#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  deploy)
    version="${2:-}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected a stable release version' >&2; exit 1; }
    remote_command="python3 - deploy '$version'"
    ;;
  cleanup) remote_command='python3 - cleanup --apply' ;;
  *) echo 'Usage: run-updater-vps.sh deploy VERSION | cleanup' >&2; exit 1 ;;
esac

: "${VPS_SSH_KEY:?}" "${VPS_KNOWN_HOSTS:?}" "${VPS_HOST:?}" "${VPS_USER:?}"
ssh_dir=$(mktemp -d)
trap 'rm -rf "$ssh_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
chmod 700 "$ssh_dir"
printf '%s\n' "$VPS_SSH_KEY" > "$ssh_dir/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
chmod 600 "$ssh_dir/key" "$ssh_dir/known_hosts"
ssh_opts=(-T -i "$ssh_dir/key" -o "UserKnownHostsFile=$ssh_dir/known_hosts"
  -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes
  -o ConnectionAttempts=1 -o ConnectTimeout=15
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3)

echo 'Checking updater VPS SSH connection and disk space'
ssh "${ssh_opts[@]}" "$VPS_USER@$VPS_HOST" \
  'command -v python3; command -v curl; test -w /var/www/updates/command-rdev-center; df -h /var/www/updates/command-rdev-center'
echo "Running updater operation: $1"
ssh "${ssh_opts[@]}" "$VPS_USER@$VPS_HOST" "$remote_command" < scripts/updater-vps.py

if [[ "$1" == deploy ]]; then
  manifest=$(mktemp "$ssh_dir/manifest.XXXXXX")
  curl --fail --silent --show-error --retry 2 --retry-delay 3 \
    --connect-timeout 10 --max-time 30 \
    "https://updates.rdev.web.id/command-rdev-center/latest.json?version=$version" > "$manifest"
  python3 - "$manifest" "$version" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
if manifest['version'] != sys.argv[2]:
    raise SystemExit('Public updater manifest does not match the deployed version')
expected = f'https://updates.rdev.web.id/command-rdev-center/command-rdev-center_{sys.argv[2]}_aarch64.app.tar.gz'
if manifest['platforms']['darwin-aarch64']['url'] != expected:
    raise SystemExit('Public updater URL is incorrect')
print(f'Public updater verified: {manifest["version"]}')
PY
fi
