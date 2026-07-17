def update_decky_music_detection_state(was_active, is_playing, missing_checks):
    if is_playing:
        return 0, True
    missing_checks = min(missing_checks + 1, 2)
    return missing_checks, was_active and missing_checks < 2


def should_scan_manual_processes(
    has_manual_process_rules,
    decky_music_active,
    current_manual_app,
    wakeup_received,
    last_scan_monotonic,
    now_monotonic,
):
    if not has_manual_process_rules or decky_music_active:
        return False
    current_name = str(current_manual_app or "").lower().replace(" ", "").replace("-", "").replace("_", "")
    if wakeup_received or current_name == "deckymusic":
        return True
    if last_scan_monotonic is None:
        return True
    return now_monotonic - last_scan_monotonic >= 120


def get_manual_app_rule_change_details(previous, current):
    previous_set = set(previous if isinstance(previous, list) else [])
    current_set = set(current if isinstance(current, list) else [])
    return (
        [f"manual_app_rule_added:{app}" for app in current if app not in previous_set]
        + [f"manual_app_rule_removed:{app}" for app in previous if app not in current_set]
    )
