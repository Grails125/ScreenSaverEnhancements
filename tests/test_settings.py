import json
import os
import tempfile
import unittest
from unittest.mock import patch

from settings import SettingsManager


class SettingsManagerTests(unittest.TestCase):
    def test_batch_update_is_saved_as_one_complete_document(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SettingsManager("settings", directory)

            self.assertTrue(manager.setSettings({"battery": 300, "ac": 600}))

            with open(manager.settings_file, "r", encoding="utf-8") as settings_file:
                self.assertEqual(json.load(settings_file), {"battery": 300, "ac": 600})

    def test_failed_atomic_replace_rolls_back_memory_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SettingsManager("settings", directory)
            self.assertTrue(manager.setSetting("battery", 300))

            with patch("settings.os.replace", side_effect=OSError("replace failed")):
                self.assertFalse(manager.setSettings({"battery": 900, "ac": 600}))

            self.assertEqual(manager.settings, {"battery": 300})
            self.assertFalse(os.path.exists(f"{manager.settings_file}.tmp"))


if __name__ == "__main__":
    unittest.main()
