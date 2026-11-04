# Updater deployment

`Release updater` builds and signs the macOS app, commits the version/tag, and publishes the three GitHub Release assets before a separate Ubuntu job deploys them to the VPS. The VPS downloads the public assets over HTTPS; the 400+ MB archive no longer travels through SCP from the macOS runner.

`scripts/run-updater-vps.sh` uses the existing `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and `VPS_KNOWN_HOSTS` secrets. SSH is noninteractive with strict host verification, connection/keepalive limits, and temporary credentials removed on exit. The VPS needs Python 3, curl, and write access to `/var/www/updates/command-rdev-center` and its user's home directory. No GitHub token is sent to the VPS.

`scripts/updater-vps.py` downloads into `~/.cache/command-rdev-center-updater` outside the public directory. It checks free disk space, verifies the size and GitHub SHA-256 digest of every asset, and checks the manifest's version, URL, and embedded signature against the signature file. The private and public directories must share a filesystem. Only verified files move to their public names; `latest.json` is renamed last. Existing conflicting files and downgrades are rejected. Repeating the same valid deployment is supported.

Downloads have bounded retries, connection/transfer/stall timeouts, and byte/speed/duration logs. The deployment job has its own 20-minute limit. If it fails after GitHub publication, rerun just the failed deployment job. Alternatively, run `Release updater` manually on `main`, with `version` set to an existing stable release such as `0.2.89`; this deploys without rebuilding or bumping the version. Manual rollback to an older version is deliberately rejected.

## Retention

After each deployment and daily at 03:23 UTC, cleanup keeps the active version and its two newest complete predecessors. Other old archives and signatures have a 24-hour grace period for clients that already fetched a manifest. Unsigned partial archives, orphan signatures, legacy `latest.json.tmp`, and abandoned private staging directories are removed after 24 hours. Signed versions newer than the active manifest are preserved as potentially pending deployments. Cleanup only targets this app's exact filename pattern and private staging prefix; unrelated files and symlinks are left alone. An invalid manifest or incomplete active release stops cleanup without deleting anything.

Deployment and cleanup share an exclusive lock. Failed downloads remove their staging directory immediately; the daily cleanup handles leftover directories from forced cancellation. A failure between moving the archive and publishing the manifest may leave a complete unreferenced archive, but does not point clients at an incomplete upload. The release remains available on GitHub after VPS retention expires.

Preview or apply cleanup through the SSH alias:

```bash
ssh vps-oracle 'python3 - cleanup' < scripts/updater-vps.py
ssh vps-oracle 'python3 - cleanup --apply' < scripts/updater-vps.py
```

Validate the deployment helper locally:

```bash
python3 -B -m unittest discover -s scripts -p 'test_updater_vps.py'
bash -n scripts/run-updater-vps.sh
```
