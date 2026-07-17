import unittest

from plugin_contract import (
    PUBLIC_SETTING_KEYS,
    normalize_persisted_settings,
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
            "ac_dim_timeout": 300,
            "ac_suspend_timeout": 600,
            "battery_dim_timeout": 300,
            "battery_suspend_timeout": 600,
            "black_background_close_on_any_key": False,
            "black_background_enabled": False,
            "black_background_opacity": 0.5,
            "manual_apps": [],
            "run_on_login": True,
            "show_notify": False,
        }
        self.assertTrue(validate_settings_batch(valid))
        self.assertFalse(validate_settings_batch({"unknown_setting": True}))
        self.assertFalse(validate_settings_batch({}))
        self.assertFalse(validate_settings_batch("manual_apps"))

    def test_normalizes_valid_public_setting_values(self):
        normalized = normalize_settings_batch({
            "manual_apps": ["  MPV  ", "mpv", "Chrome"],
            "black_background_opacity": 0.5,
            "run_on_login": True,
            "battery_dim_timeout": 300,
        })

        self.assertEqual(normalized, {
            "manual_apps": ["Chrome", "MPV"],
            "black_background_opacity": 0.5,
            "run_on_login": True,
            "battery_dim_timeout": 300,
        })

    def test_rejects_invalid_public_setting_values(self):
        self.assertIsNone(normalize_settings_batch({"manual_apps": "mpv"}))
        self.assertIsNone(normalize_settings_batch({"manual_apps": ["mpv", 42]}))
        self.assertIsNone(normalize_settings_batch({"run_on_login": "true"}))
        self.assertIsNone(normalize_settings_batch({"black_background_opacity": 1.5}))
        self.assertIsNone(normalize_settings_batch({"battery_dim_timeout": -1}))

    def test_normalizes_existing_settings_and_resets_invalid_values(self):
        updates = normalize_persisted_settings({
            "manual_apps": ["  MPV ", "mpv"],
            "run_on_login": "false",
            "show_notify": False,
            "private_recovery_state": {"active": True},
        })

        self.assertEqual(updates, {
            "manual_apps": ["MPV"],
            "run_on_login": True,
        })


if __name__ == "__main__":
    unittest.main()
