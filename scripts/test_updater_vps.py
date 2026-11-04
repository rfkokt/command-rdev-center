import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "updater", Path(__file__).with_name("updater-vps.py")
)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "public"
        self.staging = Path(self.temp.name) / "private"
        self.root.mkdir()
        self.staging.mkdir()
        self.now = 2_000_000_000
        self.add_package("0.2.88")
        self.manifest(self.root, "0.2.88")

    def manifest(self, directory, version):
        (directory / "latest.json").write_text(
            json.dumps(
                {
                    "version": version,
                    "platforms": {
                        "darwin-aarch64": {
                            "url": updater.PUBLIC + updater.filename(version),
                            "signature": "signature",
                        }
                    },
                }
            )
        )

    def add_package(self, version, signed=True, age=updater.GRACE + 1):
        package = self.root / updater.filename(version)
        package.write_bytes(b"application")
        files = [package]
        if signed:
            signature = self.root / (package.name + ".sig")
            signature.write_text("signature")
            files.append(signature)
        for path in files:
            os.utime(path, (self.now - age, self.now - age))
        return package

    def staged(self, version="0.2.89"):
        stage = self.staging / "release-test"
        stage.mkdir()
        (stage / updater.filename(version)).write_bytes(b"new application")
        (stage / (updater.filename(version) + ".sig")).write_text("signature")
        self.manifest(stage, version)
        assets = {
            p.name: {"size": p.stat().st_size, "digest": updater.digest(p)}
            for p in stage.iterdir()
        }
        return stage, assets

    def test_retention_keeps_active_and_two_predecessors_with_grace(self):
        old = self.add_package("0.2.84")
        self.add_package("0.2.85")
        self.add_package("0.2.86")
        self.add_package("0.2.87")
        recent = self.add_package("0.2.83", age=60)
        future = self.add_package("0.2.89")
        unrelated = self.root / "other-app.tar.gz"
        unrelated.write_text("leave alone")
        updater.cleanup(self.root, self.staging, apply=True, now=self.now)
        self.assertFalse(old.exists())
        self.assertFalse(Path(str(old) + ".sig").exists())
        for version in ("0.2.86", "0.2.87", "0.2.88"):
            self.assertTrue((self.root / updater.filename(version)).exists())
        self.assertTrue(recent.exists())
        self.assertTrue(future.exists())
        self.assertTrue(unrelated.exists())

    def test_cleanup_removes_stale_partial_and_stage_but_dry_run_does_not(self):
        partial = self.add_package("0.2.89", signed=False)
        stage = self.staging / "release-aborted"
        stage.mkdir()
        (stage / "partial").write_bytes(b"unfinished")
        os.utime(stage, (self.now - updater.GRACE - 1,) * 2)
        updater.cleanup(self.root, self.staging, now=self.now)
        self.assertTrue(partial.exists())
        self.assertTrue(stage.exists())
        updater.cleanup(self.root, self.staging, apply=True, now=self.now)
        self.assertFalse(partial.exists())
        self.assertFalse(stage.exists())

    def test_cleanup_fails_closed_for_bad_manifest(self):
        old = self.add_package("0.2.80")
        (self.root / "latest.json").write_text("broken")
        with self.assertRaises(ValueError):
            updater.cleanup(self.root, self.staging, apply=True, now=self.now)
        self.assertTrue(old.exists())

    def test_cleanup_fails_closed_for_incomplete_active_release(self):
        old = self.add_package("0.2.80")
        (self.root / (updater.filename("0.2.88") + ".sig")).unlink()
        with self.assertRaises(ValueError):
            updater.cleanup(self.root, self.staging, apply=True, now=self.now)
        self.assertTrue(old.exists())

    def test_cleanup_does_not_follow_symlinks(self):
        external = Path(self.temp.name) / "keep"
        external.write_text("keep")
        (self.root / updater.filename("0.2.80")).symlink_to(external)
        (self.staging / "release-link").symlink_to(
            external.parent, target_is_directory=True
        )
        updater.cleanup(self.root, self.staging, apply=True, now=self.now)
        self.assertEqual(external.read_text(), "keep")

    def test_publish_updates_manifest_after_verified_files_and_is_repeatable(self):
        stage, assets = self.staged()
        original = os.replace
        moves = []

        def replace(source, target):
            moves.append(target.name)
            original(source, target)

        with patch.object(updater.os, "replace", side_effect=replace):
            updater.publish(self.root, stage, "0.2.89", assets)
        self.assertEqual(moves[-1], "latest.json")
        self.assertEqual(
            updater.read_manifest(self.root / "latest.json")["version"], "0.2.89"
        )
        stage.rmdir()
        stage, assets = self.staged()
        updater.publish(self.root, stage, "0.2.89", assets)

    def test_bad_checksum_preserves_current_manifest_and_files(self):
        stage, assets = self.staged()
        (stage / updater.filename("0.2.89")).write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "Checksum"):
            updater.publish(self.root, stage, "0.2.89", assets)
        self.assertEqual(
            updater.read_manifest(self.root / "latest.json")["version"], "0.2.88"
        )
        self.assertFalse((self.root / updater.filename("0.2.89")).exists())

    def test_conflicting_public_file_is_not_overwritten(self):
        stage, assets = self.staged()
        conflict = self.root / updater.filename("0.2.89")
        conflict.write_bytes(b"existing release")
        with self.assertRaisesRegex(ValueError, "conflicting"):
            updater.publish(self.root, stage, "0.2.89", assets)
        self.assertEqual(conflict.read_bytes(), b"existing release")
        self.assertEqual(
            updater.read_manifest(self.root / "latest.json")["version"], "0.2.88"
        )

    def test_older_release_cannot_replace_current(self):
        stage, assets = self.staged("0.2.87")
        with self.assertRaisesRegex(ValueError, "older"):
            updater.publish(self.root, stage, "0.2.87", assets)

    def test_failed_download_cleans_private_stage_and_keeps_current(self):
        assets = {
            updater.filename("0.2.89"): {
                "size": 10,
                "browser_download_url": "https://example.invalid",
            }
        }
        with (
            patch.object(updater, "release_assets", return_value=assets),
            patch.object(
                updater, "curl", side_effect=RuntimeError("download interrupted")
            ),
            self.assertRaisesRegex(RuntimeError, "interrupted"),
        ):
            updater.deploy(self.root, self.staging, "0.2.89")
        self.assertEqual(list(self.staging.iterdir()), [])
        self.assertEqual(
            updater.read_manifest(self.root / "latest.json")["version"], "0.2.88"
        )

    def test_lock_excludes_cleanup_while_deploy_is_running(self):
        with (
            updater.locked(self.staging),
            self.assertRaises(BlockingIOError),
            updater.locked(self.staging),
        ):
            self.fail("Concurrent updater operation acquired the lock")


if __name__ == "__main__":
    unittest.main()
