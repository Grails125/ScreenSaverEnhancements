import unittest

import update_checker


class UpdateCheckerTests(unittest.TestCase):
    def test_only_reports_strictly_newer_semantic_versions(self):
        self.assertTrue(update_checker.is_newer_version("v1.5.0", "1.4.0"))
        self.assertFalse(update_checker.is_newer_version("1.4.0", "1.4.0"))
        self.assertFalse(update_checker.is_newer_version("1.3.9", "1.4.0"))

    def test_rejects_invalid_version_tags(self):
        with self.assertRaises(ValueError):
            update_checker.is_newer_version("latest", "1.4.0")

    def test_validates_release_payload_and_bounds_notes(self):
        release = update_checker.parse_release_payload({
            "tag_name": "v1.5.0",
            "body": "x" * (update_checker.MAX_RELEASE_NOTES_LENGTH + 20),
            "assets": [{
                "name": "ScreenSaverEnhancements.zip",
                "browser_download_url": "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/ScreenSaverEnhancements.zip",
                "digest": "sha256:" + "a" * 64,
            }],
        })

        self.assertEqual(release["version"], "1.5.0")
        self.assertEqual(len(release["notes"]), update_checker.MAX_RELEASE_NOTES_LENGTH)
        self.assertEqual(release["download_url"], "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/ScreenSaverEnhancements.zip")
        self.assertEqual(release["sha256"], "a" * 64)

    def test_release_without_the_expected_package_remains_checkable_but_not_installable(self):
        for assets in ([], [{
            "name": "source.zip",
            "browser_download_url": "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/source.zip",
            "digest": "sha256:" + "a" * 64,
        }]):
            with self.subTest(assets=assets):
                release = update_checker.parse_release_payload({"tag_name": "v1.5.0", "assets": assets})
                self.assertEqual(release["download_url"], "")
                self.assertEqual(release["sha256"], "")

    def test_rejects_an_expected_package_with_an_untrusted_url_or_missing_digest(self):
        invalid_releases = (
            {"tag_name": "v1.5.0", "assets": [{
                "name": "ScreenSaverEnhancements.zip",
                "browser_download_url": "https://example.com/package.zip",
                "digest": "sha256:" + "a" * 64,
            }]},
            {"tag_name": "v1.5.0", "assets": [{
                "name": "ScreenSaverEnhancements.zip",
                "browser_download_url": "https://github.com/Grails125/ScreenSaverEnhancements/releases/download/v1.5.0/ScreenSaverEnhancements.zip",
                "digest": None,
            }]},
        )
        for payload in invalid_releases:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    update_checker.parse_release_payload(payload)

    def test_rejects_release_payload_without_a_valid_tag(self):
        with self.assertRaises(ValueError):
            update_checker.parse_release_payload({"tag_name": "", "body": "notes"})


if __name__ == "__main__":
    unittest.main()
