#!/usr/bin/env python3
"""Run on the updater VPS (Python stdlib + curl only)."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path("/var/www/updates/command-rdev-center")
STAGING = Path.home() / ".cache/command-rdev-center-updater"
REPO = "rfkokt/command-rdev-center"
PUBLIC = "https://updates.rdev.web.id/command-rdev-center/"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
PACKAGE = re.compile(
    r"command-rdev-center_([0-9]+\.[0-9]+\.[0-9]+)_aarch64\.app\.tar\.gz"
)
GRACE = 24 * 60 * 60


def log(message):
    print(message, flush=True)


def version_key(version):
    if not VERSION.fullmatch(version):
        raise ValueError("Expected a stable version such as 0.2.89")
    return tuple(map(int, version.split(".")))


def filename(version):
    version_key(version)
    return f"command-rdev-center_{version}_aarch64.app.tar.gz"


def regular(path):
    return not path.is_symlink() and path.is_file()


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return "sha256:" + checksum.hexdigest()


def read_manifest(path):
    if not regular(path):
        raise ValueError("Missing regular latest.json; refusing to modify the updater")
    manifest = json.loads(path.read_text())
    expected = filename(manifest["version"])
    platform = manifest["platforms"]["darwin-aarch64"]
    if platform["url"] != PUBLIC + expected or not platform["signature"].strip():
        raise ValueError("Unexpected updater manifest")
    return manifest


def cleanup(root, staging, apply=False, now=None):
    """Keep active + two newest complete predecessors; allow 24h for clients."""
    now = time.time() if now is None else now
    manifest = read_manifest(
        root / "latest.json"
    )  # Fail closed before deleting anything.
    active = filename(manifest["version"])
    if not regular(root / active) or not regular(root / (active + ".sig")):
        raise ValueError("Active release is incomplete; refusing cleanup")
    packages = [p for p in root.iterdir() if PACKAGE.fullmatch(p.name) and regular(p)]
    previous = sorted(
        (
            p
            for p in packages
            if version_key(PACKAGE.fullmatch(p.name)[1])
            < version_key(manifest["version"])
            and regular(root / (p.name + ".sig"))
        ),
        key=lambda p: version_key(PACKAGE.fullmatch(p.name)[1]),
        reverse=True,
    )
    keep = {active, *(p.name for p in previous[:2])}
    candidates = []
    for package in packages:
        signature = root / (package.name + ".sig")
        if package.name in keep:
            continue
        # A future, signed release may be waiting for publication; leave it alone.
        if regular(signature) and version_key(
            PACKAGE.fullmatch(package.name)[1]
        ) > version_key(manifest["version"]):
            continue
        pair = [p for p in (package, signature) if regular(p)]
        if all(now - p.stat().st_mtime >= GRACE for p in pair):
            candidates.extend(pair)
    for path in root.iterdir():
        if (
            path.name.endswith(".sig")
            and PACKAGE.fullmatch(path.name[:-4])
            and regular(path)
            and not (root / path.name[:-4]).exists()
            and now - path.stat().st_mtime >= GRACE
        ):
            candidates.append(path)
        if (
            path.name == "latest.json.tmp"
            and regular(path)
            and now - path.stat().st_mtime >= GRACE
        ):
            candidates.append(path)
    for path in staging.glob("release-*"):
        if (
            not path.is_symlink()
            and path.is_dir()
            and now - path.stat().st_mtime >= GRACE
        ):
            candidates.append(path)
    freed = 0
    for path in candidates:
        size = (
            sum(p.stat().st_size for p in path.rglob("*") if regular(p))
            if path.is_dir()
            else path.stat().st_size
        )
        log(f"{'Delete' if apply else 'Would delete'} {path} ({size} bytes)")
        if apply:
            shutil.rmtree(path) if path.is_dir() else path.unlink()
        freed += size
    log(
        f"Cleanup {'freed' if apply else 'would free'} {freed} bytes; keeping {', '.join(sorted(keep))}"
    )
    return freed


def curl(url, output=None, large=False):
    command = [
        "curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "15",
        "--max-time",
        "300" if large else "30",
        "--retry",
        "2",
        "--retry-all-errors",
        "--retry-delay",
        "3",
        "--retry-max-time",
        "660" if large else "90",
        "--speed-limit",
        "1024",
        "--speed-time",
        "30",
    ]
    if output:
        command += [
            "--output",
            str(output),
            "--write-out",
            "download bytes=%{size_download} speed=%{speed_download} duration=%{time_total}\\n",
        ]
    command.append(url)
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=720 if large else 110,
        )
    except subprocess.CalledProcessError as error:
        log(f"Download failed for {url}: {error.stderr.strip()}")
        raise
    if output:
        log(result.stdout.strip())
    return result.stdout


def release_assets(version):
    version_key(version)
    release = json.loads(
        curl(f"https://api.github.com/repos/{REPO}/releases/tags/v{version}")
    )
    if (
        release["tag_name"] != "v" + version
        or release["draft"]
        or release["prerelease"]
    ):
        raise ValueError("Expected a published stable GitHub release")
    names = (filename(version), filename(version) + ".sig", "latest.json")
    assets = {
        asset["name"]: asset for asset in release["assets"] if asset["name"] in names
    }
    for name in names:
        asset = assets[name]
        if (
            not re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or "")
            or asset["size"] <= 0
        ):
            raise ValueError(f"Missing SHA-256/size for {name}")
        if (
            asset["browser_download_url"]
            != f"https://github.com/{REPO}/releases/download/v{version}/{name}"
        ):
            raise ValueError(f"Unexpected download URL for {name}")
    return assets


def publish(root, stage, version, assets):
    """Validate everything before moving immutable files; latest.json is last."""
    artifact = filename(version)
    for name, asset in assets.items():
        path = stage / name
        if (
            not regular(path)
            or path.stat().st_size != asset["size"]
            or digest(path) != asset["digest"]
        ):
            raise ValueError(f"Checksum/size mismatch: {name}")
    manifest = read_manifest(stage / "latest.json")
    if (
        manifest["version"] != version
        or manifest["platforms"]["darwin-aarch64"]["signature"]
        != (stage / (artifact + ".sig")).read_text().strip()
    ):
        raise ValueError("Manifest version/signature mismatch")
    current = (
        read_manifest(root / "latest.json") if (root / "latest.json").exists() else None
    )
    if current and version_key(version) < version_key(current["version"]):
        raise ValueError("Refusing to roll the updater back to an older version")
    for name in (artifact, artifact + ".sig"):
        target = root / name
        if (target.exists() or target.is_symlink()) and (
            not regular(target) or digest(target) != assets[name]["digest"]
        ):
            raise ValueError(f"Refusing to overwrite conflicting public asset: {name}")
    for name in (artifact, artifact + ".sig", "latest.json"):
        (stage / name).chmod(0o644)
        os.replace(stage / name, root / name)
    log(f"Published updater {version}")


def deploy(root, staging, version):
    assets = release_assets(version)
    required = sum(a["size"] for a in assets.values()) + 128 * 1024 * 1024
    if shutil.disk_usage(staging).free < required:
        raise ValueError(f"Insufficient free space: need {required} bytes")
    if root.stat().st_dev != staging.stat().st_dev:
        raise ValueError(
            "Staging and public directory must share a filesystem for atomic rename"
        )
    if (root / "latest.json").exists():
        current = read_manifest(root / "latest.json")
        if version_key(version) < version_key(current["version"]):
            raise ValueError("Refusing to download an older updater version")
    with tempfile.TemporaryDirectory(prefix="release-", dir=staging) as directory:
        stage = Path(directory)
        for name, asset in assets.items():
            log(f"Downloading {name} ({asset['size']} bytes)")
            curl(
                asset["browser_download_url"],
                stage / name,
                large=name == filename(version),
            )
        publish(root, stage, version, assets)
    cleanup(root, staging, apply=True)


@contextlib.contextmanager
def locked(staging):
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (staging / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("deploy").add_argument("version")
    commands.add_parser("cleanup").add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with locked(STAGING):
        if args.command == "deploy":
            deploy(ROOT, STAGING, args.version)
        else:
            cleanup(ROOT, STAGING, apply=args.apply)


if __name__ == "__main__":
    main()
