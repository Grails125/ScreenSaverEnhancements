import decky
import asyncio
import importlib.util
from pathlib import Path
import re
import time
from collections import deque


def load_local_module(module_name, file_name):
    module_path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(
        f"screensaver_enhancements_{module_name}",
        module_path,
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load settings module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SettingsManager = load_local_module("settings", "settings.py").SettingsManager
plugin_contract = load_local_module("contract", "plugin_contract.py")
process_events = load_local_module("process_events", "process_events.py")
update_checker = load_local_module("update_checker", "update_checker.py")
ProcessEventSource = process_events.ProcessEventSource

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
POWER_OVERRIDE_ACTIVE = "power_override_active"
POWER_OVERRIDE_SNAPSHOT = "power_override_snapshot"
LEGACY_SETTING_KEYS = (
    "custom_power_settings_enabled",
    "dim_timeout",
    "force_suspend_enabled",
    "mute_notifications",
    "system_power_settings_snapshot",
)


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

def import_third_party_lib():
    import sys
    from pathlib import Path
    plugin_dir = Path(__file__).parent.resolve()
    decky.logger.info(f'plugin dir: {plugin_dir}')
    sys.path.insert(0, str(plugin_dir))
    sys.path.insert(0, str(plugin_dir.joinpath("lib")))

def setup_environ_vars():
    import os
    os.environ['XDG_RUNTIME_DIR'] = '/run/user/1000'
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus'
    os.environ['HOME'] = '/home/deck'

import_third_party_lib()
setup_environ_vars()
decky.logger.info("Main.py Loading...")
decky.logger.info("Environment setup complete")
settings_dir = decky.DECKY_PLUGIN_SETTINGS_DIR
settings = SettingsManager(name="settings", settings_directory=settings_dir)
if settings.getSetting("manual_apps", None) is None:
    settings.setSetting("manual_apps", ["chrome", "mpv", "wiliwili"])
recent_diagnostic_events = deque(maxlen=40)
manual_inhibiting = False
inhibit_active = False
decky.logger.info(f"Settings directory: {settings_dir}")

from dbus_next.aio import MessageBus
from dbus_next import Message, MessageType
from dbus_next.service import ServiceInterface, method, dbus_property, signal
bus = None


def record_diagnostic_event(event_type, detail=None):
    entry = {"timestamp": int(time.time()), "type": str(event_type)[:64]}
    if detail:
        entry["detail"] = str(detail)[:256]
    recent_diagnostic_events.append(entry)


async def emit_manual_apps_changed():
    try:
        await decky.emit("settings_changed", "manual_apps")
        record_diagnostic_event("settings_changed", "manual_apps")
    except Exception as e:
        decky.logger.warning(f"Could not emit settings_changed: {e}")


async def emit_inhibit_state_changed():
    try:
        await decky.emit("inhibit_state_changed")
        record_diagnostic_event("inhibit_state_changed")
    except Exception as e:
        decky.logger.warning(f"Could not emit inhibit_state_changed: {e}")


def schedule_inhibit_state_changed():
    try:
        asyncio.create_task(emit_inhibit_state_changed())
    except RuntimeError as e:
        decky.logger.warning(f"Could not schedule inhibit_state_changed: {e}")


def sync_inhibit_state():
    global inhibit_active
    active = manual_inhibiting or len(BaseInterface.request_map) > 0
    if active == inhibit_active:
        return
    inhibit_active = active
    schedule_inhibit_state_changed()

class AppRequest:
    def __init__(self, sender, cookie, application, reason):
        self.sender = sender
        self.cookie = cookie
        self.application = application
        self.reason = reason
    
    async def is_connected(self):
        global bus
        message = Message(
            destination='org.freedesktop.DBus',
            path='/org/freedesktop/DBus',
            interface='org.freedesktop.DBus',
            member='GetConnectionUnixProcessID',
            signature='s',
            body=[self.sender]
        )
        reply = await bus.call(message)
        return reply.message_type != MessageType.ERROR

    def to_status(self):
        return {
            "cookie": self.cookie,
            "application": self.application,
            "reason": self.reason,
        }

class BaseInterface(ServiceInterface):
    ignore_application = ["Steam", "./steamwebhelper"]
    request_map = {}
    cookie = 0

    def __init__(self, service):
        super().__init__(service)

    async def _inhibit_impl(self, application, reason):
        if application in BaseInterface.ignore_application: return 0
        decky.logger.info(f'called Inhibit with application={application} and reason={reason}')
        sender = ServiceInterface.last_msg.sender
        BaseInterface.cookie += 1
        BaseInterface.request_map[BaseInterface.cookie] = AppRequest(sender, BaseInterface.cookie, application, reason)
        sync_inhibit_state()
        return BaseInterface.cookie

    async def _un_inhibit_impl(self, cookie):
        if cookie == 0: return
        decky.logger.info(f'called UnInhibit with cookie={cookie}')
        if BaseInterface.request_map.pop(cookie, None) is None:
            decky.logger.info(f'cannot find cookie={cookie}')
        sync_inhibit_state()

class InhibitInterface(BaseInterface):
    def __init__(self):
        super().__init__('org.freedesktop.ScreenSaver')

    @method()
    async def Inhibit(self, application: 's', reason: 's') -> 'u':
        return await self._inhibit_impl(application, reason)

    @method()
    async def UnInhibit(self, cookie: 'u'):
        return await self._un_inhibit_impl(cookie)

class PMInhibitInterface(BaseInterface):
    def __init__(self):
        super().__init__('org.freedesktop.PowerManagement.Inhibit')

    @method()
    async def Inhibit(self, application: 's', reason: 's') -> 'u':
        return await self._inhibit_impl(application, reason)

    @method()
    async def UnInhibit(self, cookie: 'u'):
        return await self._un_inhibit_impl(cookie)

class GnomeInterface(BaseInterface):
    def __init__(self):
        super().__init__('org.gnome.SessionManager')

    @method()
    async def Inhibit(self, application: 's', xid: 'u', reason: 's', flags: 'u') -> 'u':
        return await self._inhibit_impl(application, reason)

    @method()
    async def Uninhibit(self, cookie: 'u'):
        return await self._un_inhibit_impl(cookie)


def clear_dbus_requests():
    BaseInterface.request_map.clear()
    BaseInterface.cookie = 0
    sync_inhibit_state()


async def is_dbus_request_connected(request):
    try:
        return await asyncio.wait_for(request.is_connected(), timeout=2)
    except Exception as e:
        decky.logger.debug(f"D-Bus connection check failed: {e}")
        return False


async def stop_dbus():
    global bus
    try:
        if bus is not None:
            bus.disconnect()
        bus = None
    except Exception as e:
        decky.logger.info(f"error: {e}")

async def start_dbus():
    global bus
    await stop_dbus()
    clear_dbus_requests()
    try:
        bus = await MessageBus().connect()
        interface = InhibitInterface()
        pm_interface = PMInhibitInterface()
        gnome_interface = GnomeInterface()
        bus.export('/ScreenSaver', interface) # vlc
        bus.export('/org/freedesktop/ScreenSaver', interface) # chrome
        bus.export('/org/freedesktop/PowerManagement/Inhibit', pm_interface) # wiliwili
        bus.export('/org/gnome/SessionManager', gnome_interface) # mpv with https://github.com/Guldoman/mpv_inhibit_gnome installed
        await bus.request_name('org.freedesktop.PowerManagement')
        await bus.request_name('org.freedesktop.PowerManagement.Inhibit')
        await bus.request_name('org.freedesktop.ScreenSaver')
        await bus.request_name('org.gnome.SessionManager')
        return True
    except Exception as e:
        decky.logger.error(f"Could not start D-Bus services: {e}")
        await stop_dbus()
        clear_dbus_requests()
        return False

import os
import shlex
import subprocess


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


def is_decky_music_name(name):
    return normalize_process_name(name) == "deckymusic"


def get_process_lines(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        return result.stdout.splitlines() if result.returncode == 0 else []
    except Exception as e:
        decky.logger.error(f"Error getting process list: {e}")
        return []


class Plugin:
    def _init_runtime_state(self):
        if not hasattr(self, 'manual_active'):
            self.manual_active = False
        if not hasattr(self, 'manual_running_app'):
            self.manual_running_app = None
        if not hasattr(self, 'manual_watch_task'):
            self.manual_watch_task = None
        if not hasattr(self, 'manual_inhibit_process'):
            self.manual_inhibit_process = None
        if not hasattr(self, 'manual_watch_wakeup'):
            self.manual_watch_wakeup = asyncio.Event()
        if not hasattr(self, 'process_event_source'):
            self.process_event_source = None
        if not hasattr(self, 'process_event_task'):
            self.process_event_task = None
        if not hasattr(self, 'process_monitor_mode'):
            self.process_monitor_mode = "not_started"
        if not hasattr(self, 'process_scan_count'):
            self.process_scan_count = 0
        if not hasattr(self, 'last_process_scan_at'):
            self.last_process_scan_at = None
        if not hasattr(self, 'last_process_event_at'):
            self.last_process_event_at = None
        if not hasattr(self, 'active_manual_pids'):
            self.active_manual_pids = set()
        if not hasattr(self, 'dbus_connection_watch_task'):
            self.dbus_connection_watch_task = None

    async def _get_all_process_lines(self):
        self.process_scan_count += 1
        self.last_process_scan_at = int(time.time())
        return await asyncio.to_thread(get_process_lines, ['ps', '-eo', 'pid=,comm=,args='])

    async def _is_process_running(self, name):
        lines = await Plugin._get_all_process_lines(self)
        target = normalize_process_name(name)
        for line in lines:
            parts = line.split(None, 2)
            if len(parts) < 2:
                continue
            comm = parts[1]
            args = parts[2] if len(parts) > 2 else ""
            if target in process_candidates(comm, args):
                return True
        return False

    async def _find_running_manual_app(self, manual_apps):
        apps_to_check = [app for app in manual_apps if not is_decky_music_name(app)]
        if not apps_to_check:
            return None
        lines = await Plugin._get_all_process_lines(self)
        # Build candidate sets once for all running processes
        proc_candidates_list = []
        for line in lines:
            parts = line.split(None, 2)
            if len(parts) < 2:
                continue
            process_id = int(parts[0])
            comm = parts[1]
            args = parts[2] if len(parts) > 2 else ""
            proc_candidates_list.append((process_id, set(process_candidates(comm, args))))
        for app in apps_to_check:
            target = normalize_process_name(app)
            matching_pids = {
                process_id
                for process_id, proc_set in proc_candidates_list
                if target in proc_set
            }
            if matching_pids:
                self.active_manual_pids = matching_pids
                return app
        self.active_manual_pids.clear()
        return None

    def _start_manual_inhibitor(self, app):
        return

    def _stop_manual_inhibitor(self):
        self.manual_inhibit_process = None

    def _set_manual_active(self, running_app, emit_events=True):
        global manual_inhibiting
        manual_active = running_app is not None
        changed = manual_active != self.manual_active or running_app != self.manual_running_app

        if manual_active:
            Plugin._start_manual_inhibitor(self, running_app)
        else:
            Plugin._stop_manual_inhibitor(self)

        if changed:
            if manual_active:
                decky.logger.info(f"Manual Inhibit triggered by process: {running_app}")
            else:
                decky.logger.info("Manual UnInhibit: no monitored processes running")

        self.manual_active = manual_active
        self.manual_running_app = running_app
        manual_inhibiting = manual_active
        if emit_events:
            sync_inhibit_state()

    async def _manual_watch_loop(self):
        decky.logger.info("Manual process watcher started")
        while True:
            self.manual_watch_wakeup.clear()
            has_manual_process_rules = False
            try:
                manual_apps = settings.getSetting("manual_apps", [])
                has_manual_process_rules = any(
                    not is_decky_music_name(app)
                    for app in manual_apps
                )
                running_app = await Plugin._find_running_manual_app(self, manual_apps)
                Plugin._set_manual_active(self, running_app)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                decky.logger.error(f"Error in manual process watcher: {e}")
            fallback_interval = 300 if not has_manual_process_rules else 120
            try:
                await asyncio.wait_for(
                    self.manual_watch_wakeup.wait(),
                    timeout=fallback_interval,
                )
                await asyncio.sleep(0.35)
            except asyncio.TimeoutError:
                pass

    async def _process_event_loop(self):
        decky.logger.info("Kernel process event listener started")
        while True:
            try:
                event_type, process_id = await self.process_event_source.wait_for_process_change()
                self.last_process_event_at = int(time.time())
                should_reconcile = event_type == process_events.PROC_EVENT_EXIT and process_id in self.active_manual_pids
                if event_type == process_events.PROC_EVENT_EXEC:
                    should_reconcile = await asyncio.to_thread(
                        Plugin._process_matches_manual_rule,
                        self,
                        process_id,
                    )
                if should_reconcile:
                    if event_type == process_events.PROC_EVENT_EXEC:
                        self.active_manual_pids.add(process_id)
                    else:
                        self.active_manual_pids.discard(process_id)
                    self.manual_watch_wakeup.set()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.process_monitor_mode = "fallback_scan"
                decky.logger.warning(f"Kernel process event listener stopped: {e}")
                self.manual_watch_wakeup.set()
                return

    async def _dbus_connection_watch_loop(self):
        decky.logger.info("D-Bus request connection watcher started")
        while True:
            try:
                await asyncio.sleep(25)
                requests = list(BaseInterface.request_map.items())
                if not requests:
                    continue
                connected_requests = await asyncio.gather(
                    *(is_dbus_request_connected(request) for _, request in requests),
                )
                changed = False
                for (cookie, _), connected in zip(requests, connected_requests):
                    if not connected:
                        BaseInterface.request_map.pop(cookie, None)
                        changed = True
                if changed:
                    sync_inhibit_state()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                decky.logger.warning(f"D-Bus request connection check failed: {e}")

    def _process_matches_manual_rule(self, process_id):
        try:
            with open(f"/proc/{process_id}/comm", "r", encoding="utf-8", errors="replace") as comm_file:
                comm = comm_file.read().strip()
            with open(f"/proc/{process_id}/cmdline", "rb") as args_file:
                args = args_file.read().replace(b"\0", b" ").decode("utf-8", errors="replace")
        except OSError:
            return False

        candidates = set(process_candidates(comm, args))
        manual_apps = settings.getSetting("manual_apps", [])
        return any(
            normalize_process_name(app) in candidates
            for app in manual_apps
            if not is_decky_music_name(app)
        )

    def _start_manual_watch(self):
        Plugin._init_runtime_state(self)
        if self.manual_watch_task and not self.manual_watch_task.done():
            return
        try:
            source = ProcessEventSource()
            try:
                source.open()
                self.process_event_source = source
                self.process_monitor_mode = "proc_connector"
                record_diagnostic_event("process_monitor", "proc_connector")
                self.process_event_task = asyncio.create_task(Plugin._process_event_loop(self))
            except Exception as e:
                source.close()
                self.process_event_source = None
                self.process_monitor_mode = "fallback_scan"
                record_diagnostic_event("process_monitor", "fallback_scan")
                decky.logger.warning(f"Process events unavailable; using low-frequency scan: {e}")
            self.manual_watch_task = asyncio.create_task(Plugin._manual_watch_loop(self))
        except Exception as e:
            decky.logger.error(f"Error starting manual process watcher: {e}")

    def _start_dbus_connection_watch(self):
        Plugin._init_runtime_state(self)
        if self.dbus_connection_watch_task and not self.dbus_connection_watch_task.done():
            return
        self.dbus_connection_watch_task = asyncio.create_task(
            Plugin._dbus_connection_watch_loop(self),
        )

    async def _stop_manual_watch(self):
        global manual_inhibiting
        Plugin._init_runtime_state(self)
        task = self.manual_watch_task
        self.manual_watch_task = None
        connection_watch_task = self.dbus_connection_watch_task
        self.dbus_connection_watch_task = None
        event_task = self.process_event_task
        self.process_event_task = None
        if self.process_event_source is not None:
            self.process_event_source.close()
            self.process_event_source = None
        if event_task and not event_task.done():
            event_task.cancel()
            try:
                await event_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                decky.logger.error(f"Error stopping process event listener: {e}")
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                decky.logger.error(f"Error stopping manual process watcher: {e}")
        if connection_watch_task and not connection_watch_task.done():
            connection_watch_task.cancel()
            try:
                await connection_watch_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                decky.logger.error(f"Error stopping D-Bus connection watcher: {e}")
        Plugin._stop_manual_inhibitor(self)
        self.manual_active = False
        self.manual_running_app = None
        self.active_manual_pids.clear()
        self.process_monitor_mode = "stopped"
        manual_inhibiting = False
        sync_inhibit_state()

    async def start_backend(self):
        global bus
        decky.logger.info("Start backend server")
        Plugin._init_runtime_state(self)
        if bus is None:
            for attempt, retry_delay in enumerate((0, 1, 3), start=1):
                if retry_delay:
                    await asyncio.sleep(retry_delay)
                if await start_dbus():
                    break
                decky.logger.warning(f"D-Bus start attempt {attempt} failed")
            if bus is None:
                raise RuntimeError("Could not register D-Bus inhibit services")
        Plugin._start_manual_watch(self)
        Plugin._start_dbus_connection_watch(self)
        record_diagnostic_event("backend_started")
        return True

    async def stop_backend(self):
        decky.logger.info("Stop backend server")
        await Plugin._stop_manual_watch(self)
        await stop_dbus()
        clear_dbus_requests()
        await emit_inhibit_state_changed()
        record_diagnostic_event("backend_stopped")
        return True

    async def is_running(self):
        global bus
        return bus is not None

    async def get_running_processes(self):
        lines = await asyncio.to_thread(
            get_process_lines,
            ['ps', '-eo', 'comm=,user=,args='],
        )
        proc_map = {}
        for line in lines:
            parts = line.split(None, 2)
            if len(parts) >= 2:
                comm, user = parts[0], parts[1]
                args = parts[2] if len(parts) > 2 else ""
                name = display_process_name(comm, args)
                if name and not name.startswith('['):
                    proc_type = "app" if user == "deck" else "system"
                    if name not in proc_map or proc_type == "app":
                        proc_map[name] = proc_type

        result = []
        for name, ptype in proc_map.items():
            result.append({"name": name, "type": ptype})

        # 排序：应用在前，然后按名称字母排序
        result.sort(key=lambda x: (0 if x['type'] == 'app' else 1, x['name'].lower()))
        return result

    async def get_plugin_version(self):
        return decky.DECKY_PLUGIN_VERSION

    async def check_update(self):
        result = {
            "has_update": False,
            "current": "",
            "latest": "",
            "notes": "",
            "download_url": "",
            "sha256": "",
            "error": "",
        }
        try:
            current = update_checker.normalize_version(decky.DECKY_PLUGIN_VERSION)
            release = await asyncio.to_thread(update_checker.fetch_latest_release)
            latest = release["version"]
            has_update = update_checker.is_newer_version(latest, current)
            if has_update and (not release["download_url"] or not release["sha256"]):
                raise ValueError("latest release package is unavailable")
            result.update({
                "has_update": has_update,
                "current": current,
                "latest": latest,
                "notes": release["notes"],
                "download_url": release["download_url"],
                "sha256": release["sha256"],
            })
        except Exception as error:
            result["error"] = "update_check_failed"
            decky.logger.warning(f"Update check failed: {error}")
        return result

    async def get_diagnostics(self):
        Plugin._init_runtime_state(self)
        system_power_settings = await asyncio.to_thread(read_steam_power_settings)
        override_state = await Plugin.get_power_override_state(self)
        return {
            "timestamp": int(time.time()),
            "backendRunning": bus is not None,
            "processMonitorMode": self.process_monitor_mode,
            "processScanCount": self.process_scan_count,
            "lastProcessScanAt": self.last_process_scan_at,
            "lastProcessEventAt": self.last_process_event_at,
            "manualRuleCount": len(settings.getSetting("manual_apps", [])),
            "manualActiveApp": self.manual_running_app,
            "dbusRequestCount": len(BaseInterface.request_map),
            "powerOverrideActive": override_state["active"],
            "systemPowerSettings": system_power_settings,
            "recentEvents": list(recent_diagnostic_events),
        }

    async def get_inhibit_status(self):
        Plugin._init_runtime_state(self)
        manual_apps = settings.getSetting("manual_apps", [])
        dbus_requests = [
            request.to_status()
            for request in BaseInterface.request_map.values()
        ]
        return {
            "manual_apps": manual_apps,
            "manual_active_app": self.manual_running_app,
            "manual_active": self.manual_active,
            "dbus_requests": dbus_requests,
            "dbus_active": len(dbus_requests) > 0,
            "is_inhibiting": self.manual_active or len(dbus_requests) > 0,
        }

    async def get_settings(self, key: str, defaults):
        if key != "manual_apps":
            decky.logger.info('[settings] get {}'.format(key))
        return settings.getSetting(key, defaults)

    async def get_system_power_settings(self):
        result = await asyncio.to_thread(read_steam_power_settings)
        decky.logger.info(f"System power settings read: {result}")
        return result

    async def get_power_override_state(self):
        snapshot = normalize_power_settings(settings.getSetting(POWER_OVERRIDE_SNAPSHOT, None))
        active = settings.getSetting(POWER_OVERRIDE_ACTIVE, False) is True and snapshot is not None
        return {"active": active, "snapshot": snapshot if active else None}

    async def begin_power_override(self, snapshot: dict):
        normalized = normalize_power_settings(snapshot)
        if normalized is None:
            return False
        return settings.setSettings({
            POWER_OVERRIDE_ACTIVE: True,
            POWER_OVERRIDE_SNAPSHOT: normalized,
        })

    async def end_power_override(self):
        return settings.unsetSettings((POWER_OVERRIDE_ACTIVE, POWER_OVERRIDE_SNAPSHOT))

    async def set_settings(self, key: str, value):
        if not plugin_contract.validate_setting_key(key):
            decky.logger.warning(f"Rejected unknown setting key: {key!r}")
            return False
        decky.logger.info('[settings] set {}: {}'.format(key, value))
        saved = settings.setSetting(key, value)
        if saved and key == "manual_apps":
            await emit_manual_apps_changed()
            self.manual_watch_wakeup.set()
        return saved

    async def set_settings_batch(self, values: dict):
        if not plugin_contract.validate_settings_batch(values):
            decky.logger.warning("Rejected invalid settings batch")
            return False
        decky.logger.info('[settings] batch set keys: {}'.format(list(values.keys())))
        saved = settings.setSettings(values)
        if saved and "manual_apps" in values:
            await emit_manual_apps_changed()
            self.manual_watch_wakeup.set()
        return saved

    async def _main(self):
        decky.logger.info("Hello World!")
        Plugin._init_runtime_state(self)
        if not settings.unsetSettings(LEGACY_SETTING_KEYS):
            decky.logger.warning("Could not remove legacy plugin settings")
        if settings.getSetting("run_on_login", True):
            await Plugin.start_backend(self)

    async def _unload(self):
        decky.logger.info("Goodnight World!")
        await Plugin.stop_backend(self)

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass
