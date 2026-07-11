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
        })

        self.assertEqual(release["version"], "1.5.0")
        self.assertEqual(len(release["notes"]), update_checker.MAX_RELEASE_NOTES_LENGTH)

    def test_rejects_release_payload_without_a_valid_tag(self):
        with self.assertRaises(ValueError):
            update_checker.parse_release_payload({"tag_name": "", "body": "notes"})


if __name__ == "__main__":
    unittest.main()
