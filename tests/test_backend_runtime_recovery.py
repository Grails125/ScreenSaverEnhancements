import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace as NS
from contextlib import asynccontextmanager
import unittest


ROOT = Path(__file__).resolve().parents[1]


def backend_logic():
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    plugin = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Plugin')
    names = {'_init_runtime_state', '_stop_manual_watch', 'start_backend', 'stop_backend',
             '_start_backend_locked', '_stop_backend_locked', '_backend_operation_lock', '_unload',
             '_stop_nested_media_watch'}
    methods = [node for node in plugin.body
               if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    namespace = {
        'asyncio': asyncio, 'asynccontextmanager': asynccontextmanager,
        'unloading': False, 'UNLOAD_TIMEOUT': 0.025,
        'decky': NS(logger=NS(info=lambda *a: None, warning=lambda *a: None, error=lambda *a: None)),
        'DisplayWakeGuard': lambda: NS(close=async_noop),
        'record_diagnostic_event': lambda *a: None, 'sync_inhibit_state': lambda *a, **kw: None,
        'clear_dbus_requests': lambda: None,
        'cancel_inhibit_state_changed_task': async_noop,
        'emit_inhibit_state_changed': async_noop, '_stop_loader_ipc_listener': lambda *a: None,
    }

    async def stop_dbus():
        namespace['bus'] = None

    async def start_dbus():
        namespace['bus'] = NS(connected=True)
        return True

    namespace.update(bus=NS(connected=True), stop_dbus=stop_dbus, start_dbus=start_dbus)
    node = ast.ClassDef(name='Plugin', bases=[], keywords=[], body=methods, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                 'actual-backend-lifecycle', 'exec'), namespace)
    cls = namespace['Plugin']
    cls._stop_manual_inhibitor = lambda self: None

    async def watcher():
        await asyncio.Event().wait()

    cls._start_manual_watch = lambda self: setattr(self, 'manual_watch_task', asyncio.create_task(watcher()))
    cls._start_dbus_connection_watch = lambda self: setattr(self, 'dbus_connection_watch_task', asyncio.create_task(watcher()))
    cls._start_nested_media_watch = lambda self: setattr(self, 'nested_media_watch_task', asyncio.create_task(watcher()))
    return namespace, cls()


async def async_noop(*a, **kw):
    pass


class BackendLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_rapid_stop_then_start_keeps_services_and_new_watchers_running(self):
        namespace, plugin = backend_logic()
        await plugin.start_backend()
        plugin.process_event_task = asyncio.create_task(asyncio.Event().wait())
        await asyncio.sleep(0)
        stop = asyncio.create_task(plugin.stop_backend())
        await asyncio.sleep(0)
        await plugin.start_backend()
        await stop
        try:
            self.assertIsNotNone(namespace['bus'])
            self.assertFalse(plugin.manual_watch_task.done())
            self.assertFalse(plugin.dbus_connection_watch_task.done())
            self.assertFalse(plugin.nested_media_watch_task.done())
        finally:
            await plugin.stop_backend()

    async def test_unload_cancels_pending_start_and_cannot_be_restarted(self):
        namespace, plugin = backend_logic()
        namespace['bus'] = None
        entered = asyncio.Event()

        async def blocked_start():
            entered.set()
            await asyncio.Event().wait()

        namespace['start_dbus'] = blocked_start
        start = asyncio.create_task(plugin.start_backend())
        await entered.wait()
        await asyncio.wait_for(plugin._unload(), 0.15)
        try:
            self.assertTrue(start.done())
            with self.assertRaises(asyncio.CancelledError):
                await start
            self.assertFalse(await plugin.start_backend())
            self.assertIsNone(namespace['bus'])
        finally:
            start.cancel()
            await asyncio.gather(start, return_exceptions=True)

    async def test_unload_keeps_deadline_when_lifecycle_lock_is_contended(self):
        namespace, plugin = backend_logic()
        await plugin.start_backend()
        entered, release = asyncio.Event(), asyncio.Event()

        async def resistant_stop(_self):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()

        type(plugin)._stop_manual_watch = resistant_stop
        stop = asyncio.create_task(plugin.stop_backend())
        await entered.wait()
        try:
            await asyncio.wait_for(plugin._unload(), 0.15)
        finally:
            release.set()
            await asyncio.gather(stop, return_exceptions=True)
            # The artificial watcher is cancellation-resistant; original real
            # watchers are restored and stopped to leave no live test tasks.
            for task in (plugin.manual_watch_task, plugin.dbus_connection_watch_task, plugin.nested_media_watch_task):
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)


def connection_logic():
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    wanted = {'AppRequest', 'is_dbus_request_connected'}
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef)) and node.name in wanted]
    watcher = next(node for node in ast.walk(tree)
                   if isinstance(node, ast.AsyncFunctionDef) and node.name == '_dbus_connection_watch_loop')
    namespace = {'asyncio': asyncio, 'Message': lambda **kw: NS(**kw), 'MessageType': NS(ERROR='error'),
                 'decky': NS(logger=NS(info=lambda *a: None, debug=lambda *a: None, warning=lambda *a: None)),
                 'sync_inhibit_state': lambda: None, 'BaseInterface': NS(request_map={})}
    exec(compile(ast.Module(body=[*nodes, watcher], type_ignores=[]), 'actual-dbus-watcher', 'exec'), namespace)
    return namespace


class ConnectionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_wait_deadline_is_unknown_instead_of_disconnected(self):
        namespace = connection_logic()
        async def pending():
            await asyncio.Event().wait()
        namespace['asyncio'] = NS(wait_for=lambda coroutine, timeout: asyncio.wait_for(coroutine, 0.01))
        self.assertIsNone(await namespace['is_dbus_request_connected'](NS(is_connected=pending)))

    async def test_query_recovery_reuses_cookie_and_confirmed_exit_removes_it(self):
        namespace = connection_logic()
        calls = 0
        request = namespace['AppRequest'](':1.2', 1, 'mpv', 'video')
        namespace['BaseInterface'].request_map[1] = request
        observations = []
        class Bus:
            connected = True
            async def call(self, _msg):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise asyncio.TimeoutError()
                if calls == 2:
                    return NS(message_type='reply', body=[100])
                return NS(message_type='error', error_name='org.freedesktop.DBus.Error.NameHasNoOwner')
        namespace['bus'] = Bus()
        async def next_cycle(_delay):
            if calls:
                observations.append(dict(namespace['BaseInterface'].request_map))
            if calls == 3:
                raise asyncio.CancelledError()
        namespace['asyncio'] = NS(sleep=next_cycle, wait_for=asyncio.wait_for, gather=asyncio.gather,
                                 CancelledError=asyncio.CancelledError)
        with self.assertRaises(asyncio.CancelledError):
            await namespace['_dbus_connection_watch_loop'](NS())
        self.assertEqual(observations, [{1: request}, {1: request}, {}])

    async def test_daemon_query_failure_is_unknown_and_keeps_cookie_for_retry(self):
        namespace = connection_logic()

        class Bus:
            connected = True
            async def call(self, msg):
                raise asyncio.TimeoutError('transient daemon backlog')

        namespace['bus'] = Bus()
        request = namespace['AppRequest'](':1.2', 1, 'mpv', 'video')
        namespace['BaseInterface'].request_map[1] = request
        count = 0

        async def one_cycle(_delay):
            nonlocal count
            count += 1
            if count > 1:
                raise asyncio.CancelledError()

        namespace['asyncio'] = NS(sleep=one_cycle, wait_for=asyncio.wait_for, gather=asyncio.gather,
                                 CancelledError=asyncio.CancelledError)
        with self.assertRaises(asyncio.CancelledError):
            await namespace['_dbus_connection_watch_loop'](NS())
        self.assertEqual(namespace['BaseInterface'].request_map, {1: request})
        self.assertIsNone(await namespace['is_dbus_request_connected'](request))

    async def test_only_name_has_no_owner_confirms_disconnection(self):
        namespace = connection_logic()
        reply = NS(message_type='error', error_name='org.freedesktop.DBus.Error.LimitsExceeded')

        class Bus:
            connected = True
            async def call(self, _msg):
                return reply

        namespace['bus'] = Bus()
        request = namespace['AppRequest'](':1.2', 1, 'mpv', 'video')
        self.assertIsNone(await namespace['is_dbus_request_connected'](request))
        reply.error_name = 'org.freedesktop.DBus.Error.NameHasNoOwner'
        self.assertFalse(await namespace['is_dbus_request_connected'](request))
        reply.message_type = 'reply'
        self.assertTrue(await namespace['is_dbus_request_connected'](request))


if __name__ == '__main__':
    unittest.main()
