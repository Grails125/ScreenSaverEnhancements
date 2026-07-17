import unittest

from process_utils import (
    get_decky_music_rule,
    get_decky_music_rule_source,
    is_decky_music_name,
    parse_process_listing_line,
)


class ProcessListingTests(unittest.TestCase):
    def test_preserves_a_process_name_containing_spaces(self):
        line = f"{'deck':<16}{'Decky Music':<32}Decky Music (/home/deck/homebrew/plugins/Decky Music/main.py)"

        self.assertEqual(
            parse_process_listing_line(line),
            ("Decky Music", "deck", "Decky Music (/home/deck/homebrew/plugins/Decky Music/main.py)"),
        )

    def test_keeps_the_existing_decky_music_rule_name_while_recognizing_it(self):
        self.assertTrue(is_decky_music_name("DeckyMusic"))
        self.assertTrue(is_decky_music_name("Decky Music"))
        self.assertFalse(is_decky_music_name("music"))
        self.assertEqual(
            get_decky_music_rule(["chrome", "Decky Music", "wiliwili"]),
            "Decky Music",
        )
        self.assertEqual(get_decky_music_rule_source("DeckyMusic"), "legacy_cdp")
        self.assertEqual(get_decky_music_rule_source("Decky Music"), "mpris")
