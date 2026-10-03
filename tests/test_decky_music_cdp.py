import unittest

import decky_music_cdp


class DeckyMusicCdpTests(unittest.TestCase):
    def test_uses_the_expected_local_decky_music_target(self):
        self.assertEqual(decky_music_cdp.DECKY_CDP_ADDRESS, ("127.0.0.1", 8080))
        self.assertEqual(decky_music_cdp.DECKY_CDP_TARGET_TITLE, "SharedJSContext")

    def test_exposes_the_cdp_playback_check(self):
        self.assertTrue(callable(decky_music_cdp.is_playing))


if __name__ == "__main__":
    unittest.main()
