import math


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
BOOLEAN_SETTING_KEYS = frozenset({
    "black_background_close_on_any_key",
    "black_background_enabled",
    "run_on_login",
    "show_notify",
})
POWER_TIMEOUT_SETTING_KEYS = frozenset({
    "ac_dim_timeout",
    "ac_suspend_timeout",
    "battery_dim_timeout",
    "battery_suspend_timeout",
})
MAX_MANUAL_APPS = 100
MAX_MANUAL_APP_LENGTH = 256


def validate_setting_key(key):
    return isinstance(key, str) and key in PUBLIC_SETTING_KEYS


def normalize_setting_value(key, value):
    if key in BOOLEAN_SETTING_KEYS:
        return value if isinstance(value, bool) else None

    if key in POWER_TIMEOUT_SETTING_KEYS:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value if 0 <= value <= 3600 else None

    if key == "black_background_opacity":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value) if math.isfinite(value) and 0 <= value <= 1 else None

    if key == "manual_apps":
        if not isinstance(value, list) or len(value) > MAX_MANUAL_APPS:
            return None
        normalized = []
        seen = set()
        for app in value:
            if not isinstance(app, str):
                return None
            name = app.strip()
            if not name or len(name) > MAX_MANUAL_APP_LENGTH:
                return None
            name_key = name.lower()
            if name_key not in seen:
                seen.add(name_key)
                normalized.append(name)
        return sorted(normalized, key=str.lower)

    return None


def normalize_settings_batch(values):
    if not isinstance(values, dict) or not values or len(values) > len(PUBLIC_SETTING_KEYS):
        return None

    normalized = {}
    for key, value in values.items():
        if not validate_setting_key(key):
            return None
        normalized_value = normalize_setting_value(key, value)
        if normalized_value is None:
            return None
        normalized[key] = normalized_value
    return normalized


def validate_settings_batch(values):
    return normalize_settings_batch(values) is not None
