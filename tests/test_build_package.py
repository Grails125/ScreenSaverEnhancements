from pathlib import Path
import tempfile
import unittest
import zipfile

from build import verify_package


class BuildPackageTests(unittest.TestCase):
    def create_archive(self, entries):
        directory = tempfile.TemporaryDirectory()
        archive_path = Path(directory.name) / "ScreenSaverEnhancements.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            for name in entries:
                archive.writestr(name, "content")
        return directory, archive_path

    def test_accepts_a_complete_plugin_package(self):
        directory, archive_path = self.create_archive({
            "ScreenSaverEnhancements/main.py",
            "ScreenSaverEnhancements/plugin.json",
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
            "ScreenSaverEnhancements/dist/index.js",
            "ScreenSaverEnhancements/dbus_next/__init__.py",
            "ScreenSaverEnhancements/lib/x/__init__.py",
            "ScreenSaverEnhancements/dbus_next/__pycache__/message.cpython-313.pyc",
        })
        with directory:
            with self.assertRaisesRegex(ValueError, "cache"):
                verify_package(archive_path, "ScreenSaverEnhancements")


if __name__ == "__main__":
    unittest.main()
