import os
import shlex


def normalize_process_name(value):
    value = (value or "").strip()
    if not value:
        return ""
    value = value.strip("\"'")
    return os.path.basename(value).lower()


def split_process_args(args):
    if not args:
        return []
    try:
        return shlex.split(args)
    except ValueError:
        return args.split()


def process_candidates(comm, args):
    candidates = []

    def add(value):
        normalized = normalize_process_name(value)
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    add(comm)
    for token in split_process_args(args):
        add(token)

    return candidates


def display_process_name(comm, args):
    comm_name = normalize_process_name(comm)
    tokens = split_process_args(args)

    if comm_name == "flatpak":
        for index, token in enumerate(tokens):
            if token == "run":
                for app_id in tokens[index + 1:]:
                    if not app_id.startswith("-"):
                        return app_id

    if tokens:
        executable = normalize_process_name(tokens[0])
        if executable and comm_name and len(comm_name) >= 15 and executable.startswith(comm_name):
            return executable

    return comm.strip()


def parse_process_listing_line(line):
    """Parse fixed-width ps output without splitting process names on spaces."""
    user = line[:16].strip()
    comm = line[16:48].strip()
    args = line[48:].strip()
    return comm, user, args


def get_decky_music_rule_source(name):
    normalized = normalize_process_name(name)
    if normalized == "deckymusic":
        return "legacy_cdp"
    if normalized.replace(" ", "").replace("-", "").replace("_", "") == "deckymusic":
        return "mpris"
    return None


def is_decky_music_name(name):
    return get_decky_music_rule_source(name) is not None


def get_decky_music_rule(manual_apps):
    return next((app for app in manual_apps if is_decky_music_name(app)), None)
