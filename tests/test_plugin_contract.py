import unittest

from plugin_contract import (
    normalize_persisted_settings,
    normalize_setting_value,
    normalize_settings_batch,
    validate_setting_key,
    validate_settings_batch,
)


class PluginContractTests(unittest.TestCase):
    def test_accepts_only_public_plugin_setting_keys(self):
        self.assertTrue(validate_setting_key("manual_apps"))
        self.assertTrue(validate_setting_key("battery_suspend_timeout"))
        self.assertFalse(validate_setting_key("power_override_active"))
        self.assertFalse(validate_setting_key("unknown_setting"))
        self.assertFalse(validate_setting_key(123))

    def test_batch_validation_rejects_unknown_or_oversized_payloads(self):
        valid = {
            "battery_suspend_timeout": 600,
            "black_background_enabled": True,
            "black_background_opacity": 0.75,
            "manual_apps": ["mpv"],
        }
        self.assertTrue(validate_settings_batch(valid))
        self.assertFalse(validate_settings_batch({"unknown_setting": True}))
        self.assertFalse(validate_settings_batch({}))
        self.assertFalse(validate_settings_batch("manual_apps"))

    def test_normalizes_and_bounds_public_setting_values(self):
        self.assertEqual(normalize_setting_value("battery_suspend_timeout", 3600), 3600)
        self.assertIsNone(normalize_setting_value("battery_suspend_timeout", 3601))
        self.assertIsNone(normalize_setting_value("battery_suspend_timeout", True))
        self.assertEqual(normalize_setting_value("black_background_opacity", 1), 1.0)
        self.assertIsNone(normalize_setting_value("black_background_opacity", float("nan")))
        self.assertIsNone(normalize_setting_value("run_on_login", 1))

    def test_manual_apps_are_trimmed_deduplicated_and_sorted(self):
        self.assertEqual(
            normalize_setting_value("manual_apps", [" mpv ", "Chrome", "MPV"]),
            ["Chrome", "mpv"],
        )
        self.assertIsNone(normalize_setting_value("manual_apps", [""]))
        self.assertIsNone(normalize_setting_value("manual_apps", [123]))

    def test_batch_returns_normalized_values_atomically(self):
        self.assertEqual(
            normalize_settings_batch({"manual_apps": [" mpv "], "show_notify": False}),
            {"manual_apps": ["mpv"], "show_notify": False},
        )
        self.assertIsNone(normalize_settings_batch({"manual_apps": ["mpv"], "show_notify": 0}))

    def test_invalid_persisted_values_fall_back_to_defaults(self):
        self.assertEqual(
            normalize_persisted_settings({
                "battery_dim_timeout": -1,
                "manual_apps": [" mpv ", "MPV"],
                "show_notify": "yes",
                "unknown": "preserved",
            }),
            {
                "battery_dim_timeout": 300,
                "manual_apps": ["mpv"],
                "show_notify": False,
            },
        )


if __name__ == "__main__":
    unittest.main()
