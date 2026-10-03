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
    # ps represents kernel threads as [comm]. Check before basename processing
    # can turn a slash-containing worker name into an ordinary-looking suffix.
    if args.strip() == f"[{comm}]":
        return ""
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
        if executable and comm_name and len(comm_name.encode("utf-8")) >= 15 and executable.startswith(comm_name):
            return executable

    return comm.strip()


def read_process_entry(process_id, proc_root="/proc"):
    """Read fields separately so locale widths and argv spaces cannot mix them."""
    path = os.path.join(proc_root, str(process_id))
    try:
        with open(os.path.join(path, "comm"), encoding="utf-8", errors="replace") as comm_file:
            comm = comm_file.read().rstrip("\n")
        with open(os.path.join(path, "cmdline"), "rb") as args_file:
            cmdline = args_file.read()
        # Kernel threads have no argv. Also skip exited or not-yet-exec'd tasks.
        if not comm.strip() or not cmdline:
            return None
        argv = (cmdline[:-1] if cmdline.endswith(b"\0") else cmdline).split(b"\0")
        args = shlex.join(arg.decode("utf-8", errors="replace") for arg in argv)
        return {"pid": int(process_id), "comm": comm, "args": args,
                "uid": os.stat(path).st_uid}
    except (OSError, ValueError):
        # Processes can disappear between directory enumeration and either read.
        return None


def _username_for_uid(uid):
    try:
        import pwd
        return pwd.getpwuid(uid).pw_name
    except (ImportError, KeyError):
        return str(uid)


def get_process_entries(proc_root="/proc"):
    entries = []
    users = {}
    with os.scandir(proc_root) as processes:
        for process in processes:
            if not process.name.isdigit():
                continue
            entry = read_process_entry(process.name, proc_root)
            if entry is None:
                continue
            uid = entry["uid"]
            if uid not in users:
                users[uid] = _username_for_uid(uid)
            entry["user"] = users[uid]
            entries.append(entry)
    return entries


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
