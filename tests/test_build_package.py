from pathlib import Path
import tempfile
import unittest
import zipfile

from build import verify_package


class BuildPackageTests(unittest.TestCase):
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
        directory, archive_path = self.create_archive({
            "ScreenSaverEnhancements/main.py",
            "ScreenSaverEnhancements/plugin.json",
            "ScreenSaverEnhancements/package.json",
            "ScreenSaverEnhancements/dist/index.js",
            "ScreenSaverEnhancements/dbus_next/__init__.py",
            "ScreenSaverEnhancements/lib/x/__init__.py",
        })
        with directory:
            verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_a_package_without_the_frontend_entry_point(self):
        directory, archive_path = self.create_archive({
            "ScreenSaverEnhancements/main.py",
            "ScreenSaverEnhancements/plugin.json",
            "ScreenSaverEnhancements/package.json",
            "ScreenSaverEnhancements/dbus_next/__init__.py",
            "ScreenSaverEnhancements/lib/x/__init__.py",
        })
        with directory:
            with self.assertRaisesRegex(ValueError, "dist/index.js"):
                verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_python_cache_files(self):
        directory, archive_path = self.create_archive({
            "ScreenSaverEnhancements/main.py",
            "ScreenSaverEnhancements/plugin.json",
            "ScreenSaverEnhancements/package.json",
            "ScreenSaverEnhancements/dist/index.js",
            "ScreenSaverEnhancements/dbus_next/__init__.py",
            "ScreenSaverEnhancements/lib/x/__init__.py",
            "ScreenSaverEnhancements/dbus_next/__pycache__/message.cpython-313.pyc",
        })
        with directory:
            with self.assertRaisesRegex(ValueError, "cache"):
                verify_package(archive_path, "ScreenSaverEnhancements")

    def test_rejects_invalid_package_versions(self):
        entries = {
            "ScreenSaverEnhancements/main.py",
            "ScreenSaverEnhancements/plugin.json",
            "ScreenSaverEnhancements/package.json",
            "ScreenSaverEnhancements/dist/index.js",
            "ScreenSaverEnhancements/dbus_next/__init__.py",
            "ScreenSaverEnhancements/lib/x/__init__.py",
        }
        directory, archive_path = self.create_archive(entries, {
            "ScreenSaverEnhancements/package.json": '{"version": "next"}',
        })
        with directory:
            with self.assertRaisesRegex(ValueError, "version"):
                verify_package(archive_path, "ScreenSaverEnhancements")


if __name__ == "__main__":
    unittest.main()
