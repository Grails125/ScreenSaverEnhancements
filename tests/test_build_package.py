from pathlib import Path
import json
import os
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from build import PACKAGE_SOURCE_FILES, REQUIRED_PACKAGE_ENTRIES, build, verify_package


class BuildPackageTests(unittest.TestCase):
    def test_build_names_archive_from_package_version_and_preserves_plugin_root(self):
        for version in ("2.0.4", "3.2.1"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in PACKAGE_SOURCE_FILES:
                    (root / name).write_text("content", encoding="utf-8")
                (root / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
                (root / "plugin.json").write_text('{"api_version": 1}', encoding="utf-8")
                for name in ("defaults/dbus_next/__init__.py", "defaults/lib/x/__init__.py"):
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("", encoding="utf-8")
                def frontend_build(*args, **kwargs):
                    (root / "dist").mkdir()
                    (root / "dist/index.js").write_text("frontend", encoding="utf-8")
                previous_directory = Path.cwd()
                try:
                    os.chdir(root)
                    with patch("build.subprocess.run", side_effect=frontend_build):
                        build()
                finally:
                    os.chdir(previous_directory)
                archive_path = root / "build" / f"ScreenSaverEnhancements-v{version}.zip"
                self.assertTrue(archive_path.is_file())
                compatibility_path = root / "build/ScreenSaverEnhancements.zip"
                self.assertTrue(compatibility_path.is_file())
                self.assertEqual(compatibility_path.read_bytes(), archive_path.read_bytes())
                verify_package(compatibility_path, "ScreenSaverEnhancements")
                with zipfile.ZipFile(archive_path) as archive:
                    self.assertTrue(all(name.startswith("ScreenSaverEnhancements/") for name in archive.namelist()))
                    self.assertEqual(json.loads(archive.read("ScreenSaverEnhancements/package.json"))["version"], version)

    def complete_entries(self):
        return {f"ScreenSaverEnhancements/{entry}" for entry in REQUIRED_PACKAGE_ENTRIES}

    def create_archive(self, entries, overrides=None):
        directory = tempfile.TemporaryDirectory()
        archive_path = Path(directory.name) / "ScreenSaverEnhancements.zip"
        overrides = overrides or {}
        with zipfile.ZipFile(archive_path, "w") as archive:
            for name in entries:
                content = overrides.get(name)
                if content is None and name.endswith("plugin.json"):
                    content = '{"api_version": 1}'
                if content is None and name.endswith("package.json"):
                    content = '{"version": "2.0.0"}'
                archive.writestr(name, content or "content")
        return directory, archive_path

    def test_accepts_a_complete_plugin_package(self):
        directory, archive_path = self.create_archive(self.complete_entries())
        with directory:
            verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_a_package_without_the_frontend_entry_point(self):
        entries = self.complete_entries()
        entries.remove("ScreenSaverEnhancements/dist/index.js")
        directory, archive_path = self.create_archive(entries)
        with directory:
            with self.assertRaisesRegex(ValueError, "dist/index.js"):
                verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_a_package_without_a_backend_module(self):
        entries = self.complete_entries()
        entries.remove("ScreenSaverEnhancements/settings.py")
        directory, archive_path = self.create_archive(entries)
        with directory:
            with self.assertRaisesRegex(ValueError, "settings.py"):
                verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_python_cache_files(self):
        entries = self.complete_entries()
        entries.add("ScreenSaverEnhancements/dbus_next/__pycache__/message.cpython-313.pyc")
        directory, archive_path = self.create_archive(entries)
        with directory:
            with self.assertRaisesRegex(ValueError, "cache"):
                verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_invalid_package_versions(self):
        entries = self.complete_entries()
        directory, archive_path = self.create_archive(entries, {
            "ScreenSaverEnhancements/package.json": '{"version": "next"}',
        })
        with directory:
            with self.assertRaisesRegex(ValueError, "version"):
                verify_package(archive_path, "ScreenSaverEnhancements")


if __name__ == "__main__":
    unittest.main()
