import unittest

from power_settings import normalize_power_settings, parse_steam_power_settings


class PowerSettingsTests(unittest.TestCase):
    def test_normalizes_complete_power_profile(self):
        profile = {
            "batteryDim": 299.6,
            "acDim": 600,
            "batterySuspend": 900,
            "acSuspend": 0,
        }

        self.assertEqual(
            normalize_power_settings(profile),
            {
                "batteryDim": 300,
                "acDim": 600,
                "batterySuspend": 900,
                "acSuspend": 0,
            },
        )

    def test_rejects_incomplete_or_out_of_range_power_profiles(self):
        self.assertIsNone(normalize_power_settings({"batteryDim": 60}))
        self.assertIsNone(normalize_power_settings({
            "batteryDim": 60,
            "acDim": 60,
            "batterySuspend": 60,
            "acSuspend": 3601,
        }))

    def test_parses_required_timeouts_from_steam_config(self):
        config = '''
            "IdleBacklightDimBatterySeconds" "300"
            "IdleBacklightDimACSeconds" "600"
            "IdleSuspendBatterySeconds" "900"
            "IdleSuspendACSeconds" "0"
        '''

        self.assertEqual(
            parse_steam_power_settings(config),
            {
                "batteryDim": 300,
                "acDim": 600,
                "batterySuspend": 900,
                "acSuspend": 0,
            },
        )


if __name__ == "__main__":
    unittest.main()
