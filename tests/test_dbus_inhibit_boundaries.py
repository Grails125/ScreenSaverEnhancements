import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace as NS
import sys
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'defaults'))
from dbus_next import Message, MessageType, ErrorType
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method

LIMITS = {
    'MAX_DBUS_REQUESTS_PER_SENDER': 64,
    'MAX_DBUS_REQUESTS': 256,
    'MAX_DBUS_APPLICATION_BYTES': 1024,
    'MAX_DBUS_REASON_BYTES': 4096,
}


def load_logic():
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    wanted = {'AppRequest', 'BaseInterface', 'InhibitInterface', 'PMInhibitInterface', 'GnomeInterface',
              'clear_dbus_requests', 'is_dbus_request_connected'}
    nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
             and n.name in wanted]
    constants = [n for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id in LIMITS for t in n.targets)]
    watcher = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)
                   and n.name == '_dbus_connection_watch_loop')
    ns = {**LIMITS, 'ServiceInterface': ServiceInterface, 'method': method,
          'Message': Message, 'MessageType': MessageType, 'ErrorType': ErrorType, 'DBusError': DBusError,
          'asyncio': asyncio, 'decky': NS(logger=NS(info=Mock(), debug=Mock(), warning=Mock())),
          'record_diagnostic_event': Mock(), 'sync_inhibit_state': Mock(),
          'bus': NS(connected=True)}
    exec(compile(ast.Module(body=[*constants, *nodes, watcher], type_ignores=[]), 'actual-dbus-inhibition', 'exec'), ns)
    return ns


async def call_as(sender, coroutine):
    message = Message(path='/ScreenSaver', member='Inhibit', sender=sender, serial=1)
    with ServiceInterface._message_context(message):
        return await coroutine


class DbusInhibitBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = load_logic()
        self.interface = self.ns['InhibitInterface']()
        self.base = self.ns['BaseInterface']

    async def inhibit(self, sender=':1.101', application='player', reason='playing', interface=None):
        return await call_as(sender, (interface or self.interface)._inhibit_impl(application, reason))

    async def release(self, sender, cookie, interface=None):
        return await call_as(sender, (interface or self.interface)._un_inhibit_impl(cookie))

    async def test_foreign_sender_cannot_release_cookie_or_change_diagnostics(self):
        cookie = await self.inhibit()
        victim = self.base.request_map[cookie]
        self.ns['record_diagnostic_event'].reset_mock()
        self.ns['sync_inhibit_state'].reset_mock()
        with self.assertRaises(DBusError) as error:
            await self.release(':1.102', cookie)
        self.assertEqual(error.exception.type, ErrorType.ACCESS_DENIED.value)
        self.assertIs(self.base.request_map[cookie], victim)
        self.ns['record_diagnostic_event'].assert_not_called()
        self.ns['sync_inhibit_state'].assert_not_called()
        await self.release(':1.101', cookie)
        self.assertNotIn(cookie, self.base.request_map)

    async def test_same_owner_can_release_across_interfaces_but_other_owner_cannot(self):
        pm = self.ns['PMInhibitInterface']()
        gnome = self.ns['GnomeInterface']()
        cookie = await self.inhibit(interface=pm)
        with self.assertRaises(DBusError):
            await self.release(':1.102', cookie, interface=gnome)
        await self.release(':1.101', cookie, interface=gnome)
        self.assertEqual(self.base.request_map, {})

    async def test_per_sender_quota_is_shared_across_interfaces_and_recovers_after_release(self):
        self.ns['MAX_DBUS_REQUESTS_PER_SENDER'] = 2
        pm = self.ns['PMInhibitInterface']()
        cookie = await self.inhibit()
        await self.inhibit(interface=pm)
        last_cookie = self.base.cookie
        self.ns['record_diagnostic_event'].reset_mock()
        with self.assertRaises(DBusError) as error:
            await self.inhibit(interface=self.ns['GnomeInterface']())
        self.assertEqual(error.exception.type, ErrorType.LIMITS_EXCEEDED.value)
        self.assertEqual(self.base.cookie, last_cookie)
        self.ns['record_diagnostic_event'].assert_not_called()
        # Another sender has its own quota; releasing an owned request frees capacity.
        await self.inhibit(':1.102')
        await self.release(':1.101', cookie)
        await self.inhibit(interface=pm)
        self.assertEqual(len(self.base.request_map), 3)

    async def test_global_quota_counts_all_senders_and_recovers_after_clear(self):
        self.ns['MAX_DBUS_REQUESTS'] = 3
        for sender in (':1.101', ':1.102', ':1.103'):
            await self.inhibit(sender)
        with self.assertRaises(DBusError) as error:
            await self.inhibit(':1.104')
        self.assertEqual(error.exception.type, ErrorType.LIMITS_EXCEEDED.value)
        self.assertEqual(len(self.base.request_map), 3)
        await self.release(':1.101', 1)
        await self.inhibit(':1.104')
        self.assertEqual(len(self.base.request_map), 3)
        self.ns['clear_dbus_requests']()
        self.assertEqual(await self.inhibit(':1.104'), 1)

    async def test_application_and_reason_limits_measure_utf8_bytes(self):
        for key, field in (('MAX_DBUS_APPLICATION_BYTES', 'application'), ('MAX_DBUS_REASON_BYTES', 'reason')):
            maximum = self.ns[key]
            with self.subTest(field=field):
                allowed = 'é' * (maximum // 2)
                cookie = await self.inhibit(**{field: allowed})
                await self.release(':1.101', cookie)
                last_cookie = self.base.cookie
                self.ns['record_diagnostic_event'].reset_mock()
                with self.assertRaises(DBusError) as error:
                    await self.inhibit(**{field: allowed + 'a'})
                self.assertEqual(error.exception.type, ErrorType.LIMITS_EXCEEDED.value)
                self.assertEqual(self.base.cookie, last_cookie)
                self.assertEqual(self.base.request_map, {})
                self.ns['record_diagnostic_event'].assert_not_called()

    async def test_oversized_application_and_reason_ascii_are_rejected(self):
        for key, field in (('MAX_DBUS_APPLICATION_BYTES', 'application'), ('MAX_DBUS_REASON_BYTES', 'reason')):
            with self.subTest(field=field):
                with self.assertRaises(DBusError):
                    await self.inhibit(**{field: 'x' * (self.ns[key] + 1)})
        self.assertEqual(self.base.request_map, {})

    async def test_ignored_steam_calls_do_not_consume_capacity(self):
        self.ns['MAX_DBUS_REQUESTS'] = 1
        await self.inhibit()
        self.assertEqual(await self.inhibit(application='Steam'), 0)
        self.assertEqual(await self.inhibit(application='./steamwebhelper'), 0)
        self.assertEqual(len(self.base.request_map), 1)

    async def test_zero_or_unknown_cookie_does_not_remove_another_request(self):
        cookie = await self.inhibit()
        await self.release(':1.102', 0)
        await self.release(':1.102', cookie + 1)
        self.assertIn(cookie, self.base.request_map)

    def test_default_limits_are_generous_but_bounded(self):
        for key, expected in LIMITS.items():
            self.assertEqual(self.ns[key], expected)


class DbusSenderLivenessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = load_logic()
        self.base = self.ns['BaseInterface']

    def add(self, sender, cookie):
        request = self.ns['AppRequest'](sender, cookie, 'player', 'playing')
        self.base.request_map[cookie] = request
        return request

    async def sweep(self, query):
        self.ns['is_dbus_request_connected'] = query
        ticks = []
        async def one_tick(delay):
            ticks.append(delay)
            if len(ticks) > 1: raise asyncio.CancelledError()
        self.ns['asyncio'] = NS(sleep=one_tick, gather=asyncio.gather, wait_for=asyncio.wait_for,
                                CancelledError=asyncio.CancelledError)
        with self.assertRaises(asyncio.CancelledError):
            await self.ns['_dbus_connection_watch_loop'](NS())
        self.assertEqual(ticks, [25, 25])

    async def test_only_one_liveness_query_per_sender_and_all_disconnected_cookies_removed(self):
        self.add(':1.101', 1)
        self.add(':1.101', 2)
        self.add(':1.102', 3)
        queried = []
        async def query(request):
            queried.append(request.sender)
            return request.sender != ':1.101'
        await self.sweep(query)
        self.assertCountEqual(queried, [':1.101', ':1.102'])
        self.assertEqual(list(self.base.request_map), [3])
        self.ns['sync_inhibit_state'].assert_called_once()

    async def test_unknown_query_result_keeps_all_sender_requests(self):
        self.add(':1.101', 1)
        self.add(':1.101', 2)
        queried = []
        async def query(request):
            queried.append(request.sender)
            return None
        await self.sweep(query)
        self.assertEqual(queried, [':1.101'])
        self.assertEqual(list(self.base.request_map), [1, 2])
        self.ns['sync_inhibit_state'].assert_not_called()

    async def test_requests_created_during_sweep_are_retained(self):
        self.add(':1.101', 1)
        async def query(request):
            self.add(':1.101', 2)
            self.add(':1.102', 3)
            return False
        await self.sweep(query)
        self.assertEqual(list(self.base.request_map), [2, 3])

    async def test_replacement_request_reusing_cookie_is_not_deleted_by_old_reply(self):
        self.add(':1.101', 1)
        replacement = None
        async def query(request):
            nonlocal replacement
            self.base.request_map.clear()
            replacement = self.add(':1.102', 1)
            return False
        await self.sweep(query)
        self.assertIs(self.base.request_map.get(1), replacement)
        self.ns['sync_inhibit_state'].assert_not_called()

    async def test_connection_change_during_queries_does_not_publish_old_results(self):
        self.add(':1.101', 1)
        old = self.base.request_map[1]
        async def query(request):
            self.ns['bus'] = NS(connected=True)
            return False
        await self.sweep(query)
        self.assertIs(self.base.request_map.get(1), old)
        self.ns['sync_inhibit_state'].assert_not_called()

    async def test_sender_query_failure_does_not_drop_any_request(self):
        self.add(':1.101', 1)
        self.add(':1.101', 2)
        async def query(request): raise RuntimeError('daemon error')
        await self.sweep(query)
        self.assertEqual(list(self.base.request_map), [1, 2])
        self.ns['sync_inhibit_state'].assert_not_called()

    async def test_real_helper_keeps_failed_sender_but_releases_confirmed_exited_sender(self):
        self.add(':1.101', 1)
        self.add(':1.101', 2)
        self.add(':1.102', 3)
        queries = []
        class Bus:
            connected = True
            async def call(self, message):
                sender = message.body[0]
                queries.append(sender)
                if sender == ':1.101':
                    raise asyncio.TimeoutError('daemon backlog')
                return NS(message_type=MessageType.ERROR,
                          error_name='org.freedesktop.DBus.Error.NameHasNoOwner')
        self.ns['bus'] = Bus()
        await self.sweep(self.ns['is_dbus_request_connected'])
        self.assertCountEqual(queries, [':1.101', ':1.102'])
        self.assertEqual(list(self.base.request_map), [1, 2])
        self.ns['sync_inhibit_state'].assert_called_once()

    async def test_sweep_frees_sender_quota_after_confirmed_exit(self):
        interface = self.ns['InhibitInterface']()
        self.ns['MAX_DBUS_REQUESTS_PER_SENDER'] = 1
        self.add(':1.101', 1)
        async def query(request): return False
        await self.sweep(query)
        cookie = await call_as(':1.101', interface._inhibit_impl('player', 'playing'))
        self.assertIn(cookie, self.base.request_map)

if __name__ == '__main__': unittest.main()
