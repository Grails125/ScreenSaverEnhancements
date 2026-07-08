import decky_plugin
import queue
from settings import SettingsManager

def import_third_party_lib():
    import sys
    from pathlib import Path
    plugin_dir = Path(__file__).parent.resolve()
    decky_plugin.logger.info(f'plugin dir: {plugin_dir}')
    sys.path.insert(0, str(plugin_dir))
    sys.path.insert(0, str(plugin_dir.joinpath("lib")))

def setup_environ_vars():
    import os
    os.environ['XDG_RUNTIME_DIR'] = '/run/user/1000'
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus'
    os.environ['HOME'] = '/home/deck'

import_third_party_lib()
setup_environ_vars()
decky_plugin.logger.info("Main.py Loading...")
decky_plugin.logger.info("Environment setup complete")
settings_dir = decky_plugin.DECKY_PLUGIN_SETTINGS_DIR
settings = SettingsManager(name="settings", settings_directory=settings_dir)
event_queue = queue.Queue()
decky_plugin.logger.info(f"Settings directory: {settings_dir}")

import asyncio
from dbus_next.aio import MessageBus
from dbus_next import Message, MessageType
from dbus_next.service import ServiceInterface, method, dbus_property, signal
bus = None

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
        decky_plugin.logger.info(f'called Inhibit with application={application} and reason={reason}')
        event_queue.put({"type": "Inhibit"})
        sender = ServiceInterface.last_msg.sender
        BaseInterface.cookie += 1
        BaseInterface.request_map[BaseInterface.cookie] = AppRequest(sender, BaseInterface.cookie, application, reason)
        return BaseInterface.cookie

    async def _un_inhibit_impl(self, cookie):
        if cookie == 0: return
        decky_plugin.logger.info(f'called UnInhibit with cookie={cookie}')
        if BaseInterface.request_map.pop(cookie, None) is None:
            decky_plugin.logger.info(f'cannot find cookie={cookie}')
        if len(BaseInterface.request_map) == 0:
            event_queue.put({"type": "UnInhibit"})

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

async def stop_dbus():
    global bus
    try:
        if bus is not None:
            bus.disconnect()
        bus = None
    except Exception as e:
        decky_plugin.logger.info(f"error: {e}")

async def start_dbus():
    global bus
    await stop_dbus()
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
    except Exception as e:
        decky_plugin.logger.info(f"error: {e}")

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

    def _get_all_process_lines(self):
        try:
            res = subprocess.run(['ps', '-eo', 'comm=,args='], capture_output=True, text=True)
            if res.returncode == 0:
                return res.stdout.splitlines()
        except Exception as e:
            decky_plugin.logger.error(f"Error getting process list: {e}")
        return []

    def _is_process_running(self, name):
        lines = Plugin._get_all_process_lines(self)
        target = normalize_process_name(name)
        for line in lines:
            parts = line.split(None, 1)
            if not parts:
                continue
            comm = parts[0]
            args = parts[1] if len(parts) > 1 else ""
            if target in process_candidates(comm, args):
                return True
        return False

    def _find_running_manual_app(self, manual_apps):
        apps_to_check = [app for app in manual_apps if not is_decky_music_name(app)]
        if not apps_to_check:
            return None
        lines = Plugin._get_all_process_lines(self)
        # Build candidate sets once for all running processes
        proc_candidates_list = []
        for line in lines:
            parts = line.split(None, 1)
            if not parts:
                continue
            comm = parts[0]
            args = parts[1] if len(parts) > 1 else ""
            proc_candidates_list.append(set(process_candidates(comm, args)))
        for app in apps_to_check:
            target = normalize_process_name(app)
            for proc_set in proc_candidates_list:
                if target in proc_set:
                    return app
        return None

    def _start_manual_inhibitor(self, app):
        return

    def _stop_manual_inhibitor(self):
        self.manual_inhibit_process = None

    def _set_manual_active(self, running_app, emit_events=True):
        manual_active = running_app is not None
        changed = manual_active != self.manual_active or running_app != self.manual_running_app

        if manual_active:
            Plugin._start_manual_inhibitor(self, running_app)
        else:
            Plugin._stop_manual_inhibitor(self)

        if changed:
            if manual_active:
                decky_plugin.logger.info(f"Manual Inhibit triggered by process: {running_app}")
                if emit_events:
                    event_queue.put({"type": "Inhibit"})
            else:
                decky_plugin.logger.info("Manual UnInhibit: no monitored processes running")
                if emit_events and len(BaseInterface.request_map) == 0:
                    event_queue.put({"type": "UnInhibit"})

        self.manual_active = manual_active
        self.manual_running_app = running_app

    async def _manual_watch_loop(self):
        decky_plugin.logger.info("Manual process watcher started")
        while True:
            try:
                manual_apps = settings.getSetting("manual_apps", [])
                running_app = Plugin._find_running_manual_app(self, manual_apps)
                Plugin._set_manual_active(self, running_app)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                decky_plugin.logger.error(f"Error in manual process watcher: {e}")
            sleep_interval = 30 if not self.manual_active else 5
            await asyncio.sleep(sleep_interval)

    def _start_manual_watch(self):
        Plugin._init_runtime_state(self)
        if self.manual_watch_task and not self.manual_watch_task.done():
            return
        try:
            self.manual_watch_task = asyncio.create_task(Plugin._manual_watch_loop(self))
        except Exception as e:
            decky_plugin.logger.error(f"Error starting manual process watcher: {e}")

    async def _stop_manual_watch(self):
        Plugin._init_runtime_state(self)
        task = self.manual_watch_task
        self.manual_watch_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                decky_plugin.logger.error(f"Error stopping manual process watcher: {e}")
        Plugin._stop_manual_inhibitor(self)
        self.manual_active = False
        self.manual_running_app = None

    async def start_backend(self):
        decky_plugin.logger.info("Start backend server")
        Plugin._init_runtime_state(self)
        await start_dbus()
        Plugin._start_manual_watch(self)

    async def stop_backend(self):
        decky_plugin.logger.info("Stop backend server")
        await Plugin._stop_manual_watch(self)
        await stop_dbus()
        event_queue.queue.clear()

    async def is_running(self):
        global bus
        return bus is not None

    async def get_running_processes(self):
        try:
            # 获取进程名和所属用户
            res = subprocess.run(['ps', '-eo', 'comm=,user=,args='], capture_output=True, text=True)
            if res.returncode == 0:
                lines = res.stdout.splitlines()
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
            return []
        except Exception as e:
            decky_plugin.logger.error(f"Error getting processes: {e}")
            return []

    async def get_event(self):
        Plugin._init_runtime_state(self)
        global bus
        if bus is None:
            return []
        res = []
        while not event_queue.empty():
            try:
                res.append(event_queue.get_nowait())
            except queue.Empty:
                continue
        # check closed dbus connection (only when there are active cookies)
        cookies = list(BaseInterface.request_map.keys())
        clear = False
        if cookies:
            for c in cookies:
                connected = await BaseInterface.request_map[c].is_connected()
                if not connected:
                    BaseInterface.request_map.pop(c)
                    clear = True

        dbus_active = len(BaseInterface.request_map) > 0
        if clear and not dbus_active:
            res.append({"type": "UnInhibit"})

        # manual apps state is managed by _manual_watch_loop, just read current state
        manual_active = self.manual_active

        if len(res) > 0:
            # filter UnInhibit if anything is still active
            if manual_active or dbus_active:
                res = [e for e in res if e['type'] != 'UnInhibit']
            decky_plugin.logger.info(f"get_event returning events: {res}")
            return res

        return []

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
            decky_plugin.logger.info('[settings] get {}'.format(key))
        return settings.getSetting(key, defaults)

    async def set_settings(self, key: str, value):
        decky_plugin.logger.info('[settings] set {}: {}'.format(key, value))
        return settings.setSetting(key, value)

    async def _main(self):
        decky_plugin.logger.info("Hello World!")
        Plugin._init_runtime_state(self)
        if settings.getSetting("run_on_login", True):
            await Plugin.start_backend(self)

    async def _unload(self):
        decky_plugin.logger.info("Goodnight World!")
        await Plugin._stop_manual_watch(self)
        await stop_dbus()

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass
