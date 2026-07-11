PUBLIC_SETTING_KEYS = frozenset({
    "ac_dim_timeout",
    "ac_suspend_timeout",
    "battery_dim_timeout",
    "battery_suspend_timeout",
    "black_background_close_on_any_key",
    "black_background_enabled",
    "black_background_opacity",
    "manual_apps",
    "run_on_login",
    "show_notify",
})


def validate_setting_key(key):
    return isinstance(key, str) and key in PUBLIC_SETTING_KEYS


def validate_settings_batch(values):
    if not isinstance(values, dict) or not values:
        return False
    return len(values) <= len(PUBLIC_SETTING_KEYS) and all(
        validate_setting_key(key)
        for key in values
    )
