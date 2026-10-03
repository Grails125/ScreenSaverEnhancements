import decky
import asyncio
import importlib.util
import os
from pathlib import Path
import time
from collections import deque
from contextlib import asynccontextmanager


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
process_utils = load_local_module("process_utils", "process_utils.py")
power_settings = load_local_module("power_settings", "power_settings.py")
decky_music_cdp = load_local_module("decky_music_cdp", "decky_music_cdp.py")
manual_watch_utils = load_local_module("manual_watch_utils", "manual_watch_utils.py")
update_checker = load_local_module("update_checker", "update_checker.py")
task_lifecycle = load_local_module("task_lifecycle", "task_lifecycle.py")
ProcessEventSource = process_events.ProcessEventSource
ManagedTask = task_lifecycle.ManagedTask
normalize_power_settings = power_settings.normalize_power_settings
read_steam_power_settings = power_settings.read_steam_power_settings
is_decky_music_playing_cdp = decky_music_cdp.is_playing
update_decky_music_detection_state = manual_watch_utils.update_decky_music_detection_state
should_scan_manual_processes = manual_watch_utils.should_scan_manual_processes
get_manual_app_rule_change_details = manual_watch_utils.get_manual_app_rule_change_details
POWER_OVERRIDE_ACTIVE = "power_override_active"
POWER_OVERRIDE_SNAPSHOT = "power_override_snapshot"
UNLOAD_TIMEOUT = 3.5  # Decky kills a plugin after five seconds.
MPRIS_REFRESH_TIMEOUT = 2.0
MAX_DBUS_REQUESTS_PER_SENDER = 64
MAX_DBUS_REQUESTS = 256
MAX_DBUS_APPLICATION_BYTES = 1024
MAX_DBUS_REASON_BYTES = 4096
POWER_OVERRIDE_OWNER = "power_override_owner"
LEGACY_SETTING_KEYS = (
    "custom_power_settings_enabled",
    "dim_timeout",
    "force_suspend_enabled",
    "mute_notifications",
    "system_power_settings_snapshot",
)
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
DisplayWakeGuard = load_local_module("display_wake_guard", "display_wake_guard.py").DisplayWakeGuard
decky.logger.info("Main.py Loading...")
decky.logger.info("Environment setup complete")
settings_dir = decky.DECKY_PLUGIN_SETTINGS_DIR
settings = SettingsManager(name="settings", settings_directory=settings_dir)
if settings.recovery_file:
    decky.logger.warning("Recovered from an invalid plugin settings file")
persisted_setting_updates = plugin_contract.normalize_persisted_settings(settings.settings)
if persisted_setting_updates and not settings.setSettings(persisted_setting_updates):
    decky.logger.warning("Could not normalize persisted plugin settings")
if settings.getSetting("manual_apps", None) is None:
    settings.setSetting("manual_apps", ["chrome", "mpv", "wiliwili"])
recent_diagnostic_events = deque(maxlen=40)
manual_inhibiting = False
inhibit_active = False
unloading = False
decky.logger.info(f"Settings directory: {settings_dir}")

from dbus_next.aio import MessageBus
from dbus_next import Message, MessageType, NameFlag, RequestNameReply, ErrorType
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method, dbus_property, signal
bus = None
inhibit_state_changed_task = ManagedTask()
DECKY_MUSIC_MPRIS_PREFIX = "org.mpris.MediaPlayer2.decky_music."
decky_music_mpris_owners = {}
decky_music_mpris_states = {}
decky_music_mpris_revisions = {}
decky_music_mpris_refresh_generation = 0
decky_music_mpris_change_callback = None


async def _is_decky_music_playing_mpris():
    """Return the event-maintained state of every active Decky Music MPRIS instance."""
    return any(decky_music_mpris_states.values())


async def refresh_decky_music_mpris_state():
    """Keep optional player discovery from delaying all background monitoring."""
    current_bus = bus
    previous_states = dict(decky_music_mpris_states)
    try:
        await asyncio.wait_for(_refresh_decky_music_mpris_state(), MPRIS_REFRESH_TIMEOUT)
    except Exception as error:
        decky.logger.debug(f"DeckyMusic MPRIS discovery unavailable: {error}")
        # A partial refresh may have received valid player replies before a
        # second player failed. Publish those changes without losing signals.
        if (bus is current_bus and previous_states != decky_music_mpris_states
                and decky_music_mpris_change_callback):
            decky_music_mpris_change_callback()


async def _refresh_decky_music_mpris_state():
    """Discover dynamic MPRIS instances and obtain their initial playback state."""
    global decky_music_mpris_owners, decky_music_mpris_states
    global decky_music_mpris_refresh_generation
    decky_music_mpris_refresh_generation += 1
    generation = decky_music_mpris_refresh_generation
    current_bus = bus
    if bus is None:
        decky_music_mpris_owners = {}
        decky_music_mpris_states = {}
        return
    names_reply = await current_bus.call(Message(
        destination="org.freedesktop.DBus",
        path="/org/freedesktop/DBus",
        interface="org.freedesktop.DBus",
        member="ListNames",
    ))
    if bus is not current_bus or generation != decky_music_mpris_refresh_generation:
        return
    if names_reply.message_type == MessageType.ERROR:
        return
    services = [
        name for name in names_reply.body[0]
        if name.startswith(DECKY_MUSIC_MPRIS_PREFIX)
    ]
    previous_states = dict(decky_music_mpris_states)
    owners = {}
    for service in services:
        owner_reply = await current_bus.call(Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus",
            member="GetNameOwner",
            signature="s",
            body=[service],
        ))
        if bus is not current_bus or generation != decky_music_mpris_refresh_generation:
            return
        if owner_reply.message_type == MessageType.ERROR or not owner_reply.body:
            continue
        owner = owner_reply.body[0]
        owners[owner] = service
        # Subscribe to this sender before awaiting Get. Signals that arrive while
        # the query is pending must win over its older PlaybackStatus snapshot.
        decky_music_mpris_owners[owner] = service
        revision = decky_music_mpris_revisions.get(service, 0)
        status_reply = await current_bus.call(Message(
            destination=service,
            path="/org/mpris/MediaPlayer2",
            interface="org.freedesktop.DBus.Properties",
            member="Get",
            signature="ss",
            body=["org.mpris.MediaPlayer2.Player", "PlaybackStatus"],
        ))
        if bus is not current_bus or generation != decky_music_mpris_refresh_generation:
            return
        if (status_reply.message_type != MessageType.ERROR and status_reply.body
                and revision == decky_music_mpris_revisions.get(service, 0)):
            decky_music_mpris_states[service] = status_reply.body[0].value == "Playing"
    active_services = set(owners.values())
    decky_music_mpris_owners = owners
    decky_music_mpris_states = {
        service: playing for service, playing in decky_music_mpris_states.items()
        if service in active_services
    }
    changed = previous_states != decky_music_mpris_states
    if changed and decky_music_mpris_change_callback:
        decky_music_mpris_change_callback()


def handle_decky_music_mpris_message(message):
    global decky_music_mpris_refresh_generation
    if message.message_type != MessageType.SIGNAL:
        return False
    if message.interface == "org.freedesktop.DBus" and message.member == "NameOwnerChanged":
        if message.body and str(message.body[0]).startswith(DECKY_MUSIC_MPRIS_PREFIX):
            service, old_owner, new_owner = message.body
            # Invalidate pending queries immediately, before the refresh task runs.
            decky_music_mpris_refresh_generation += 1
            if old_owner:
                decky_music_mpris_owners.pop(old_owner, None)
            decky_music_mpris_states.pop(service, None)
            decky_music_mpris_revisions[service] = decky_music_mpris_revisions.get(service, 0) + 1
            if new_owner:
                decky_music_mpris_owners[new_owner] = service
            if decky_music_mpris_change_callback:
                decky_music_mpris_change_callback()
            asyncio.create_task(refresh_decky_music_mpris_state())
    elif (
        message.interface == "org.freedesktop.DBus.Properties"
        and message.member == "PropertiesChanged"
        and message.path == "/org/mpris/MediaPlayer2"
        and message.sender in decky_music_mpris_owners
        and len(message.body) >= 2
        and message.body[0] == "org.mpris.MediaPlayer2.Player"
        and "PlaybackStatus" in message.body[1]
    ):
        service = decky_music_mpris_owners[message.sender]
        decky_music_mpris_revisions[service] = decky_music_mpris_revisions.get(service, 0) + 1
        decky_music_mpris_states[service] = message.body[1]["PlaybackStatus"].value == "Playing"
        if decky_music_mpris_change_callback:
            decky_music_mpris_change_callback()
    return False


async def is_decky_music_playing_mpris():
    """Read playback state for the current Decky Music MPRIS implementation."""
    try:
        mpris_state = await _is_decky_music_playing_mpris()
        if mpris_state is not None:
            return mpris_state
    except Exception as error:
        decky.logger.debug(f"DeckyMusic MPRIS playback detection unavailable: {error}")
    return False


async def is_decky_music_playing_legacy():
    """Read playback state for the legacy DeckyMusic CEF implementation."""
    return await asyncio.to_thread(is_decky_music_playing_cdp)


def record_diagnostic_event(event_type, detail=None, **fields):
    entry = {"timestamp": int(time.time()), "type": str(event_type)[:64]}
    if detail:
        entry["detail"] = str(detail)[:256]
    for key, value in fields.items():
        if value is not None:
            entry[str(key)[:32]] = value
    recent_diagnostic_events.append(entry)


async def emit_manual_apps_changed(details=None):
    try:
        await decky.emit("settings_changed", "manual_apps")
        for detail in details or ["manual_apps"]:
            record_diagnostic_event("settings_changed", detail)
    except Exception as e:
        decky.logger.warning(f"Could not emit settings_changed: {e}")


async def emit_inhibit_state_changed(detail=None):
    if unloading:
        return
    try:
        await decky.emit("inhibit_state_changed")
        record_diagnostic_event("inhibit_state_changed", detail)
    except Exception as e:
        decky.logger.warning(f"Could not emit inhibit_state_changed: {e}")


def schedule_inhibit_state_changed(detail=None):
    if unloading:
        return
    try:
        inhibit_state_changed_task.schedule(lambda: emit_inhibit_state_changed(detail))
    except RuntimeError as e:
        decky.logger.warning(f"Could not schedule inhibit_state_changed: {e}")


async def cancel_inhibit_state_changed_task(wait=True):
    try:
        if wait:
            await inhibit_state_changed_task.cancel_and_wait()
        else:
            task = inhibit_state_changed_task.task
            inhibit_state_changed_task.task = None
            if task is not None and not task.done():
                task.cancel()
    except Exception as error:
        decky.logger.warning(f"Could not stop inhibit_state_changed task: {error}")


def sync_inhibit_state(detail=None):
    global inhibit_active
    active = manual_inhibiting or len(BaseInterface.request_map) > 0
    if active == inhibit_active:
        return
    inhibit_active = active
    schedule_inhibit_state_changed(detail)

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
        if reply.message_type == MessageType.ERROR:
            if reply.error_name == 'org.freedesktop.DBus.Error.NameHasNoOwner':
                return False
            raise RuntimeError(f"D-Bus connection query failed: {reply.error_name}")
        return True

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
        sender = ServiceInterface.get_current_message().sender
        for label, value, maximum in (
            ('application', application, MAX_DBUS_APPLICATION_BYTES),
            ('reason', reason, MAX_DBUS_REASON_BYTES),
        ):
            # Reject obviously oversized strings before encoding them. D-Bus
            # has already validated these arguments as UTF-8 strings.
            if len(value) > maximum or len(value.encode('utf-8')) > maximum:
                raise DBusError(ErrorType.LIMITS_EXCEEDED, f'{label} exceeds {maximum} UTF-8 bytes')
        if len(BaseInterface.request_map) >= MAX_DBUS_REQUESTS:
            raise DBusError(ErrorType.LIMITS_EXCEEDED, 'Too many inhibition requests')
        sender_requests = sum(request.sender == sender for request in BaseInterface.request_map.values())
        if sender_requests >= MAX_DBUS_REQUESTS_PER_SENDER:
            raise DBusError(ErrorType.LIMITS_EXCEEDED, 'Too many inhibition requests for this sender')
        decky.logger.info(f'called Inhibit with application={application} and reason={reason}')
        BaseInterface.cookie += 1
        BaseInterface.request_map[BaseInterface.cookie] = AppRequest(sender, BaseInterface.cookie, application, reason)
        record_diagnostic_event(
            "dbus_request",
            "inhibit",
            application=application,
            reason=reason,
            cookie=BaseInterface.cookie,
        )
        sync_inhibit_state()
        return BaseInterface.cookie

    async def _un_inhibit_impl(self, cookie):
        if cookie == 0: return
        request = BaseInterface.request_map.get(cookie)
        if request is not None:
            sender = ServiceInterface.get_current_message().sender
            if request.sender != sender:
                raise DBusError(ErrorType.ACCESS_DENIED, 'Inhibition request belongs to another sender')
            BaseInterface.request_map.pop(cookie)
        decky.logger.info(f'called UnInhibit with cookie={cookie}')
        if request is None:
            decky.logger.info(f'cannot find cookie={cookie}')
        record_diagnostic_event(
            "dbus_request",
            "uninhibit",
            application=request.application if request else None,
            reason=request.reason if request else None,
            cookie=cookie,
        )
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
        return None  # An unavailable query does not prove that the sender exited.


async def stop_dbus():
    global bus, decky_music_mpris_owners, decky_music_mpris_states
    global decky_music_mpris_refresh_generation
    decky_music_mpris_refresh_generation += 1
    try:
        if bus is not None:
            bus.disconnect()
    except Exception as e:
        decky.logger.info(f"error: {e}")
    finally:
        bus = None
        decky_music_mpris_owners = {}
        decky_music_mpris_states = {}
        decky_music_mpris_revisions.clear()
        if decky_music_mpris_change_callback:
            decky_music_mpris_change_callback()

async def start_dbus():
    global bus
    await stop_dbus()
    clear_dbus_requests()
    try:
        bus = await MessageBus().connect()
        bus.add_message_handler(handle_decky_music_mpris_message)
        for match_rule in (
            "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'",
            "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2'",
        ):
            await bus.call(Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="AddMatch",
                signature="s",
                body=[match_rule],
            ))
        interface = InhibitInterface()
        pm_interface = PMInhibitInterface()
        gnome_interface = GnomeInterface()
        bus.export('/ScreenSaver', interface) # vlc
        bus.export('/org/freedesktop/ScreenSaver', interface) # chrome
        bus.export('/org/freedesktop/PowerManagement/Inhibit', pm_interface) # wiliwili
        bus.export('/org/gnome/SessionManager', gnome_interface) # mpv with https://github.com/Guldoman/mpv_inhibit_gnome installed
        for name in (
            'org.freedesktop.PowerManagement',
            'org.freedesktop.PowerManagement.Inhibit',
            'org.freedesktop.ScreenSaver',
            'org.gnome.SessionManager',
        ):
            reply = await bus.request_name(name, NameFlag.DO_NOT_QUEUE)
            if reply not in (RequestNameReply.PRIMARY_OWNER, RequestNameReply.ALREADY_OWNER):
                raise RuntimeError(f'D-Bus service name is already owned: {name} ({reply})')
        await refresh_decky_music_mpris_state()
        return True
    except Exception as e:
        decky.logger.error(f"Could not start D-Bus services: {e}")
        await stop_dbus()
        clear_dbus_requests()
        return False

import subprocess

normalize_process_name = process_utils.normalize_process_name
process_candidates = process_utils.process_candidates
display_process_name = process_utils.display_process_name
get_decky_music_rule_source = process_utils.get_decky_music_rule_source
is_decky_music_name = process_utils.is_decky_music_name
get_decky_music_rule = process_utils.get_decky_music_rule


def get_process_lines(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        return result.stdout.splitlines() if result.returncode == 0 else []
    except Exception as e:
        decky.logger.error(f"Error getting process list: {e}")
        return []


def _stop_loader_ipc_listener(plugin):
    """Avoid Decky 3.2.9's non-yielding server-listener loop after IPC EOF."""
    current = asyncio.current_task()
    stopped = 0
    async def ignore_message(_message):
        return None
    for task in asyncio.all_tasks():
        if task is current:
            continue
        coroutine = task.get_coro()
        if getattr(coroutine, '__qualname__', None) != 'UnixSocket._listen_for_method_call':
            continue
        frame = getattr(coroutine, 'cr_frame', None)
        socket = frame.f_locals.get('self') if frame is not None else None
        if socket is None or type(socket).__module__ not in (
            'decky_loader.localplatform.localsocket', 'localplatform.localsocket',
        ):
            continue
        runner = getattr(getattr(socket, 'on_new_message', None), '__self__', None)
        if getattr(runner, 'Plugin', None) is not plugin:
            continue
        reader = frame.f_locals.get('reader')
        if isinstance(reader, asyncio.StreamReader):
            # Its current loop iteration unconditionally invokes this callback
            # after read. Give that final empty read a harmless result, then let
            # the loop exit normally rather than faulting the server callback.
            socket.active = False
            socket.on_new_message = ignore_message
            reader.feed_eof()
        else:
            # Ownership is proven, but an unfamiliar reader cannot be drained
            # safely using the known 3.2.9 StreamReader protocol.
            task.cancel()
        stopped += 1
    return stopped


class Plugin:
    def _init_runtime_state(self):
        if not hasattr(self, 'display_wake_guard'):
            self.display_wake_guard = DisplayWakeGuard()
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
        if not hasattr(self, 'last_manual_process_scan_monotonic'):
            self.last_manual_process_scan_monotonic = None
        if not hasattr(self, 'last_process_event_at'):
            self.last_process_event_at = None
        if not hasattr(self, 'active_manual_pids'):
            self.active_manual_pids = set()
        if not hasattr(self, 'dbus_connection_watch_task'):
            self.dbus_connection_watch_task = None
        if not hasattr(self, 'decky_music_detection_error_logged'):
            self.decky_music_detection_error_logged = False
        if not hasattr(self, 'decky_music_missing_checks'):
            self.decky_music_missing_checks = 0

    async def _get_all_process_entries(self):
        self.process_scan_count += 1
        self.last_process_scan_at = int(time.time())
        self.last_manual_process_scan_monotonic = time.monotonic()
        return await asyncio.to_thread(process_utils.get_process_entries)

    async def _find_running_manual_app(self, manual_apps):
        apps_to_check = [app for app in manual_apps if not is_decky_music_name(app)]
        if not apps_to_check:
            return None
        entries = await Plugin._get_all_process_entries(self)
        # Build candidate sets once for all running processes
        proc_candidates_list = []
        for entry in entries:
            proc_candidates_list.append((entry["pid"], set(process_candidates(entry["comm"], entry["args"]))))
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
        previous_running_app = self.manual_running_app
        manual_active = running_app is not None
        changed = manual_active != self.manual_active or running_app != self.manual_running_app

        if manual_active:
            Plugin._start_manual_inhibitor(self, running_app)
        else:
            Plugin._stop_manual_inhibitor(self)

        inhibit_detail = None
        if changed:
            if manual_active:
                decky.logger.info(f"Manual Inhibit triggered by process: {running_app}")
                inhibit_detail = f"manual_app_inhibiting:{running_app}"
            else:
                decky.logger.info("Manual UnInhibit: no monitored processes running")
                inhibit_detail = f"manual_app_released:{previous_running_app}"
            if is_decky_music_name(running_app):
                record_diagnostic_event("decky_music_playback", "decky_music_playing")
            elif is_decky_music_name(previous_running_app):
                record_diagnostic_event("decky_music_playback", "decky_music_stopped")

        self.manual_active = manual_active
        self.manual_running_app = running_app
        manual_inhibiting = manual_active
        if emit_events:
            sync_inhibit_state(inhibit_detail)

    async def _manual_watch_loop(self):
        global decky_music_mpris_change_callback
        decky_music_mpris_change_callback = self.manual_watch_wakeup.set
        decky.logger.info("Manual process watcher started")
        process_scan_wakeup = True
        while True:
            self.manual_watch_wakeup.clear()
            has_manual_process_rules = False
            has_legacy_decky_music_rule = False
            decky_music_rule = None
            try:
                manual_apps = settings.getSetting("manual_apps", [])
                has_manual_process_rules = any(
                    not is_decky_music_name(app)
                    for app in manual_apps
                )
                decky_music_rules = [
                    (app, get_decky_music_rule_source(app))
                    for app in manual_apps
                    if is_decky_music_name(app)
                ]
                has_decky_music_rule = bool(decky_music_rules)
                has_legacy_decky_music_rule = any(source == "legacy_cdp" for _, source in decky_music_rules)
                decky_music_playing = False
                decky_music_detection_succeeded = has_decky_music_rule
                if has_decky_music_rule:
                    for rule, source in decky_music_rules:
                        try:
                            is_playing = (
                                await is_decky_music_playing_mpris()
                                if source == "mpris"
                                else await is_decky_music_playing_legacy()
                            )
                            if is_playing:
                                decky_music_playing = True
                                decky_music_rule = rule
                                break
                        except Exception as error:
                            decky_music_detection_succeeded = False
                            if not self.decky_music_detection_error_logged:
                                decky.logger.warning(f"DeckyMusic playback detection unavailable: {error}")
                                self.decky_music_detection_error_logged = True
                    if decky_music_detection_succeeded:
                        self.decky_music_detection_error_logged = False
                if has_decky_music_rule:
                    if decky_music_detection_succeeded:
                        was_decky_music_active = is_decky_music_name(self.manual_running_app)
                        self.decky_music_missing_checks, decky_music_active = update_decky_music_detection_state(
                            was_decky_music_active,
                            decky_music_playing,
                            self.decky_music_missing_checks,
                            confirm_missing=has_legacy_decky_music_rule,
                        )
                        if was_decky_music_active and self.decky_music_missing_checks == 1:
                            decky.logger.info("DeckyMusic audio was temporarily not detected; waiting for confirmation")
                            record_diagnostic_event(
                                "decky_music_playback",
                                "decky_music_audio_temporarily_missing",
                            )
                    else:
                        decky_music_active = is_decky_music_name(self.manual_running_app)
                else:
                    self.decky_music_missing_checks = 0
                    decky_music_active = False
                scan_manual_processes = should_scan_manual_processes(
                    has_manual_process_rules,
                    decky_music_active,
                    self.manual_running_app,
                    process_scan_wakeup,
                    self.last_manual_process_scan_monotonic,
                    time.monotonic(),
                )
                if decky_music_active:
                    running_app = decky_music_rule or self.manual_running_app
                elif not has_manual_process_rules:
                    running_app = None
                elif scan_manual_processes:
                    running_app = await Plugin._find_running_manual_app(self, manual_apps)
                else:
                    running_app = self.manual_running_app
                Plugin._set_manual_active(self, running_app)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                decky.logger.error(f"Error in manual process watcher: {e}")
            fallback_interval = 5 if has_legacy_decky_music_rule else (
                300 if not has_manual_process_rules else 120
            )
            try:
                await asyncio.wait_for(
                    self.manual_watch_wakeup.wait(),
                    timeout=fallback_interval,
                )
                process_scan_wakeup = True
                await asyncio.sleep(0.35)
            except asyncio.TimeoutError:
                process_scan_wakeup = False

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
                if bus is None or not bus.connected:
                    async with Plugin._backend_operation_lock(self):
                        if unloading:
                            return
                        # Another explicit start may have recovered while the
                        # watcher waited for the lifecycle lock.
                        if bus is None or not bus.connected:
                            await Plugin._start_backend_locked(self)
                    continue
                requests = list(BaseInterface.request_map.items())
                if not requests:
                    continue
                current_bus = bus
                requests_by_sender = {request.sender: request for _, request in requests}
                connected_senders = dict(zip(requests_by_sender, await asyncio.gather(
                    *(is_dbus_request_connected(request) for request in requests_by_sender.values()),
                )))
                if bus is not current_bus or not current_bus.connected:
                    continue
                changed = False
                for cookie, request in requests:
                    if (connected_senders[request.sender] is False
                            and BaseInterface.request_map.get(cookie) is request):
                        BaseInterface.request_map.pop(cookie, None)
                        changed = True
                if changed:
                    sync_inhibit_state()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                decky.logger.warning(f"D-Bus request connection check failed: {e}")

    def _process_matches_manual_rule(self, process_id):
        entry = process_utils.read_process_entry(process_id)
        if entry is None:
            return False

        candidates = set(process_candidates(entry["comm"], entry["args"]))
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
        global decky_music_mpris_change_callback
        decky_music_mpris_change_callback = None
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

    @asynccontextmanager
    async def _backend_operation_lock(self):
        if not hasattr(self, 'backend_lifecycle_lock'):
            self.backend_lifecycle_lock = asyncio.Lock()
        async with self.backend_lifecycle_lock:
            self.backend_lifecycle_operation = asyncio.current_task()
            try:
                yield
            finally:
                self.backend_lifecycle_operation = None

    async def start_backend(self):
        async with Plugin._backend_operation_lock(self):
            if unloading:
                return False
            return await Plugin._start_backend_locked(self)

    async def _start_backend_locked(self):
        global bus
        decky.logger.info("Start backend server")
        Plugin._init_runtime_state(self)
        if bus is None or not bus.connected:
            await stop_dbus()
            clear_dbus_requests()
            for attempt, retry_delay in enumerate((0, 1, 3), start=1):
                if retry_delay:
                    await asyncio.sleep(retry_delay)
                if await start_dbus():
                    break
                decky.logger.warning(f"D-Bus start attempt {attempt} failed")
            if bus is None or not bus.connected:
                raise RuntimeError("Could not register D-Bus inhibit services")
        Plugin._start_manual_watch(self)
        Plugin._start_dbus_connection_watch(self)
        record_diagnostic_event("backend_started")
        return True

    async def stop_backend(self, emit_state=True):
        async with Plugin._backend_operation_lock(self):
            return await Plugin._stop_backend_locked(self, emit_state=emit_state)

    async def _stop_backend_locked(self, emit_state=True):
        decky.logger.info("Stop backend server")
        try:
            await Plugin._stop_manual_watch(self)
        finally:
            # Even cancellation of a watcher must release services and cookies.
            await stop_dbus()
            clear_dbus_requests()
            await cancel_inhibit_state_changed_task(wait=emit_state)
        if emit_state:
            await emit_inhibit_state_changed()
        record_diagnostic_event("backend_stopped")
        return True

    async def is_running(self):
        global bus
        return bus is not None and bus.connected

    async def get_running_processes(self):
        entries = await asyncio.to_thread(process_utils.get_process_entries)
        proc_map = {}
        for entry in entries:
            name = display_process_name(entry["comm"], entry["args"])
            if name and not name.startswith('['):
                proc_type = "app" if entry["user"] == "deck" else "system"
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

    async def get_installed_plugin_version(self):
        try:
            package_path = os.path.join(decky.DECKY_PLUGIN_DIR, "package.json")
            return await asyncio.to_thread(update_checker.read_package_version, package_path)
        except Exception as error:
            decky.logger.warning(f"Could not read installed plugin version: {error}")
            return ""

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
            "backendRunning": bus is not None and bus.connected,
            "processMonitorMode": self.process_monitor_mode,
            "processScanCount": self.process_scan_count,
            "lastProcessScanAt": self.last_process_scan_at,
            "lastProcessEventAt": self.last_process_event_at,
            "manualRuleCount": len(settings.getSetting("manual_apps", [])),
            "manualActiveApp": self.manual_running_app,
            "dbusRequestCount": len(BaseInterface.request_map),
            "powerOverrideActive": override_state["active"],
            "powerOverrideSnapshot": override_state["snapshot"],
            "systemPowerSettings": system_power_settings,
            "recentEvents": list(recent_diagnostic_events),
        }

    async def clear_diagnostic_events(self):
        recent_diagnostic_events.clear()
        return True

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
        if not plugin_contract.validate_setting_key(key):
            decky.logger.warning("Rejected non-public setting read")
            return defaults
        if key != "manual_apps":
            decky.logger.info('[settings] get {}'.format(key))
        return settings.getSetting(key, defaults)

    async def get_system_power_settings(self):
        result = await asyncio.to_thread(read_steam_power_settings)
        decky.logger.info(f"System power settings read: {result}")
        return result

    async def start_display_wake_guard(self):
        Plugin._init_runtime_state(self)
        return await self.display_wake_guard.start()

    async def heartbeat_display_wake_guard(self, token: str):
        Plugin._init_runtime_state(self)
        return await self.display_wake_guard.heartbeat(token)

    async def stop_display_wake_guard(self, token: str):
        Plugin._init_runtime_state(self)
        return await self.display_wake_guard.stop(token)

    async def get_power_override_state(self):
        snapshot = normalize_power_settings(settings.getSetting(POWER_OVERRIDE_SNAPSHOT, None))
        active = settings.getSetting(POWER_OVERRIDE_ACTIVE, False) is True and snapshot is not None
        owner = settings.getSetting(POWER_OVERRIDE_OWNER, None)
        return {"active": active, "snapshot": snapshot if active else None, "owner": owner}

    async def begin_power_override(self, snapshot: dict, owner: str = None, expected_owner: str = None):
        normalized = normalize_power_settings(snapshot)
        if normalized is None:
            return False
        for value in (owner, expected_owner):
            if value is not None and (not isinstance(value, str) or not 0 < len(value) <= 128):
                return False
        if owner is not None and owner == expected_owner:
            return False
        state = await Plugin.get_power_override_state(self)
        if state["owner"] != expected_owner:
            return False
        # These settings writes do not yield: ownership comparison and commit are atomic.
        return settings.setSettings({
            POWER_OVERRIDE_ACTIVE: True,
            POWER_OVERRIDE_SNAPSHOT: normalized,
            POWER_OVERRIDE_OWNER: owner,
        })

    async def end_power_override(self, owner: str = None, next_owner: str = None):
        if next_owner is not None and (not isinstance(next_owner, str) or not 0 < len(next_owner) <= 128 or next_owner == owner):
            return False
        if owner is not None and next_owner is None:
            return False
        state = await Plugin.get_power_override_state(self)
        if state["owner"] != owner:
            return False
        if next_owner is not None:
            # Keep an inactive revision so delayed requests cannot recreate a cleared override.
            return settings.setSettings({
                POWER_OVERRIDE_ACTIVE: False,
                POWER_OVERRIDE_SNAPSHOT: None,
                POWER_OVERRIDE_OWNER: next_owner,
            })
        return settings.unsetSettings((POWER_OVERRIDE_ACTIVE, POWER_OVERRIDE_SNAPSHOT, POWER_OVERRIDE_OWNER))

    async def save_power_settings(self, profile: dict, owner: str, expected_owner: str = None):
        normalized = normalize_power_settings(profile)
        if normalized is None or not isinstance(owner, str) or not 0 < len(owner) <= 128:
            return False
        if expected_owner is not None and (not isinstance(expected_owner, str) or not 0 < len(expected_owner) <= 128):
            return False
        if owner == expected_owner:
            return False
        state = await Plugin.get_power_override_state(self)
        if state["owner"] != expected_owner:
            return False
        # Profile persistence and revision advance are one non-yielding commit.
        # Keep an active recovery snapshot until the native mutation has finished.
        return settings.setSettings({
            "battery_dim_timeout": normalized["batteryDim"],
            "ac_dim_timeout": normalized["acDim"],
            "battery_suspend_timeout": normalized["batterySuspend"],
            "ac_suspend_timeout": normalized["acSuspend"],
            POWER_OVERRIDE_OWNER: owner,
        })

    async def set_settings(self, key: str, value):
        normalized = plugin_contract.normalize_settings_batch({key: value})
        if normalized is None:
            decky.logger.warning(f"Rejected invalid setting: {key!r}")
            return False
        value = normalized[key]
        previous_manual_apps = settings.getSetting("manual_apps", []) if key == "manual_apps" else []
        decky.logger.info('[settings] set {}: {}'.format(key, value))
        saved = settings.setSetting(key, value)
        if saved and key == "manual_apps":
            await emit_manual_apps_changed(get_manual_app_rule_change_details(previous_manual_apps, value))
            self.manual_watch_wakeup.set()
        return saved

    async def set_settings_batch(self, values: dict):
        normalized = plugin_contract.normalize_settings_batch(values)
        if normalized is None:
            decky.logger.warning("Rejected invalid settings batch")
            return False
        values = normalized
        previous_manual_apps = settings.getSetting("manual_apps", []) if "manual_apps" in values else []
        decky.logger.info('[settings] batch set keys: {}'.format(list(values.keys())))
        saved = settings.setSettings(values)
        if saved and "manual_apps" in values:
            await emit_manual_apps_changed(get_manual_app_rule_change_details(previous_manual_apps, values["manual_apps"]))
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
        global unloading
        decky.logger.info("Goodnight World!")
        unloading = True
        Plugin._init_runtime_state(self)
        # Stop only this plugin's Loader IPC reader before the first yield.
        # Loader closes its peer first; otherwise EOF can starve every timer.
        _stop_loader_ipc_listener(self)
        # A start/stop RPC may own the lifecycle lock while awaiting another
        # service. Cancel it before the bounded cleanup tries to acquire it.
        operation = getattr(self, 'backend_lifecycle_operation', None)
        if operation is not None and operation is not asyncio.current_task():
            operation.cancel()
        tasks = {
            asyncio.create_task(self.display_wake_guard.close()),
            asyncio.create_task(Plugin.stop_backend(self, emit_state=False)),
        }
        done, pending = await asyncio.wait(tasks, timeout=UNLOAD_TIMEOUT)
        for task in pending:
            task.cancel()
        if pending:
            decky.logger.warning("Plugin cleanup exceeded its total unload budget")
        for task in done:
            if not task.cancelled() and task.exception() is not None:
                decky.logger.warning(f"Plugin cleanup failed: {task.exception()}")

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass
