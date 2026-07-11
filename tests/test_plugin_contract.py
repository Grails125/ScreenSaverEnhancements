import unittest

from plugin_contract import (
    PUBLIC_SETTING_KEYS,
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
        valid = {key: index for index, key in enumerate(PUBLIC_SETTING_KEYS)}
        self.assertTrue(validate_settings_batch(valid))
        self.assertFalse(validate_settings_batch({"unknown_setting": True}))
        self.assertFalse(validate_settings_batch({}))
        self.assertFalse(validate_settings_batch("manual_apps"))


if __name__ == "__main__":
    unittest.main()
