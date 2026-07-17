import re


STEAM_CONFIG_PATHS = (
    "/home/deck/.local/share/Steam/config/config.vdf",
    "/home/deck/.steam/steam/config/config.vdf",
)
STEAM_POWER_SETTING_KEYS = {
    "batteryDim": "IdleBacklightDimBatterySeconds",
    "acDim": "IdleBacklightDimACSeconds",
    "batterySuspend": "IdleSuspendBatterySeconds",
    "acSuspend": "IdleSuspendACSeconds",
}


def normalize_power_settings(value):
    if not isinstance(value, dict):
        return None
    result = {}
    for key in STEAM_POWER_SETTING_KEYS:
        timeout = value.get(key)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            return None
        timeout = round(timeout)
        if timeout < 0 or timeout > 3600:
            return None
        result[key] = timeout
    return result


def parse_steam_power_settings(text):
    result = {}
    for output_key, steam_key in STEAM_POWER_SETTING_KEYS.items():
        match = re.search(r'"{}"\s+"(\d+)"'.format(re.escape(steam_key)), text)
        if match is None:
            return None
        result[output_key] = int(match.group(1))
    return result


def read_steam_power_settings():
    for path in STEAM_CONFIG_PATHS:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as config_file:
                parsed = parse_steam_power_settings(config_file.read())
            if parsed is not None:
                return parsed
        except OSError:
            continue
    return None
