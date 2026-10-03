import unittest
import json
import tempfile
from pathlib import Path

import update_checker


class UpdateCheckerTests(unittest.TestCase):
    def asset(self, name, tag="v2.0.4"):
        return {
            "name": name,
            "browser_download_url": f"https://github.com/Grails125/ScreenSaverEnhancements/releases/download/{tag}/{name}",
            "digest": "sha256:" + "b" * 64,
        }

    def test_selects_versioned_package_matching_release_tag(self):
        name = "ScreenSaverEnhancements-v2.0.4.zip"
        release = update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": [self.asset(name)]})
        self.assertEqual(release["download_url"], self.asset(name)["browser_download_url"])
        self.assertEqual(release["sha256"], "b" * 64)

    def test_prefers_versioned_asset_over_legacy_compatibility_alias(self):
        for reverse in (False, True):
            assets = [self.asset("ScreenSaverEnhancements.zip"), self.asset("ScreenSaverEnhancements-v2.0.4.zip")]
            if reverse:
                assets.reverse()
            with self.subTest(reverse=reverse):
                release = update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": assets})
                self.assertTrue(release["download_url"].endswith("/ScreenSaverEnhancements-v2.0.4.zip"))

    def test_wrong_version_asset_is_ignored_and_legacy_alias_remains_supported(self):
        wrong = self.asset("ScreenSaverEnhancements-v2.0.3.zip")
        release = update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": [wrong]})
        self.assertEqual(release["download_url"], "")
        release = update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": [wrong, self.asset("ScreenSaverEnhancements.zip")]})
        self.assertTrue(release["download_url"].endswith("/ScreenSaverEnhancements.zip"))

    def test_asset_url_must_match_selected_name_and_exact_release_tag(self):
        for name in ("ScreenSaverEnhancements.zip", "ScreenSaverEnhancements-v2.0.4.zip"):
            for url in (
                self.asset(name, "v2.0.3")["browser_download_url"],
                self.asset(name)["browser_download_url"].replace("/v2.0.4/", "/extra/v2.0.4/"),
                self.asset("source.zip")["browser_download_url"],
                self.asset(name)["browser_download_url"].replace("github.com/", "github.com:444/"),
            ):
                with self.subTest(name=name, url=url):
                    asset = dict(self.asset(name), browser_download_url=url)
                    with self.assertRaises(ValueError):
                        update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": [asset]})

    def test_invalid_versioned_digest_does_not_fall_back_to_legacy_asset(self):
        asset = dict(self.asset("ScreenSaverEnhancements-v2.0.4.zip"), digest=None)
        with self.assertRaises(ValueError):
            update_checker.parse_release_payload({"tag_name": "v2.0.4", "assets": [self.asset("ScreenSaverEnhancements.zip"), asset]})

    def test_reads_and_normalizes_the_version_written_by_decky_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            package_path = Path(directory) / "package.json"
            package_path.write_text(json.dumps({"version": "v2.1.0"}), encoding="utf-8")

            self.assertEqual(update_checker.read_package_version(package_path), "2.1.0")

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
