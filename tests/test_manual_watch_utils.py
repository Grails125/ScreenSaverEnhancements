import unittest

from manual_watch_utils import (
    get_manual_app_rule_change_details,
    should_scan_manual_processes,
    update_decky_music_detection_state,
)


class ManualWatchUtilsTests(unittest.TestCase):
    def test_keeps_decky_music_active_until_two_missed_checks(self):
        self.assertEqual(update_decky_music_detection_state(True, False, 0), (1, True))
        self.assertEqual(update_decky_music_detection_state(True, False, 1), (2, False))
        self.assertEqual(update_decky_music_detection_state(True, True, 1), (0, True))
        self.assertEqual(update_decky_music_detection_state(False, False, 0), (1, False))

    def test_only_scans_manual_processes_when_required(self):
        self.assertFalse(should_scan_manual_processes(True, True, "DeckyMusic", False, 0, 120))
        self.assertFalse(should_scan_manual_processes(True, False, "mpv", False, 100, 104))
        self.assertTrue(should_scan_manual_processes(True, False, "mpv", True, 100, 104))
        self.assertTrue(should_scan_manual_processes(True, False, "mpv", False, 100, 220))
        self.assertTrue(should_scan_manual_processes(True, False, "DeckyMusic", False, 100, 104))
        self.assertFalse(should_scan_manual_processes(False, False, None, True, None, 0))

    def test_describes_manual_rule_additions_and_removals_in_order(self):
        self.assertEqual(
            get_manual_app_rule_change_details(["mpv", "chrome"], ["chrome", "vlc"]),
            ["manual_app_rule_added:vlc", "manual_app_rule_removed:mpv"],
        )


if __name__ == "__main__":
    unittest.main()
