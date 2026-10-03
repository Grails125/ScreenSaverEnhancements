import ast
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'defaults'))

from dbus_next import Message, ErrorType
from dbus_next.errors import DBusError
from dbus_next.aio import MessageBus
from dbus_next.message_bus import BaseMessageBus
from dbus_next.service import ServiceInterface
from dbus_next.signature import SignatureTree


class ReplyCollector:
    def __init__(self):
        self.messages = []
        self.errors = []

    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        if error is not None:
            self.errors.append(error)
        return error is not None

    def __call__(self, message):
        self.messages.append(message)


def request(sender, body=None, signature=''):
    return Message(path='/ScreenSaver', member='Inhibit', sender=sender,
                   serial=1, signature=signature, body=body or [])


def method(fn, signature=''):
    return SimpleNamespace(fn=fn, out_signature=signature,
                           out_signature_tree=SignatureTree(signature))


class DbusRequestContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        source = ast.parse((Path(__file__).resolve().parents[1] / 'main.py').read_text(encoding='utf-8'))
        app_request = next(node for node in source.body if isinstance(node, ast.ClassDef)
                           and node.name == 'AppRequest')
        functions = [node for node in ast.walk(source)
                     if isinstance(node, ast.AsyncFunctionDef)
                     and node.name in ('_inhibit_impl', '_un_inhibit_impl')]
        limits = [node for node in source.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id.startswith('MAX_DBUS_')
                          for target in node.targets)]
        self.base = SimpleNamespace(ignore_application=[], cookie=0, request_map={})
        self.scope = {
            'ServiceInterface': ServiceInterface,
            'BaseInterface': self.base,
            'ErrorType': ErrorType, 'DBusError': DBusError,
            'decky': SimpleNamespace(logger=SimpleNamespace(info=lambda *args: None)),
            'record_diagnostic_event': lambda *args, **kwargs: None,
            'sync_inhibit_state': lambda: None,
        }
        exec(compile(ast.Module(body=[*limits, app_request, *functions], type_ignores=[]),
                     'main.py', 'exec'), self.scope)

    async def test_simultaneous_inhibits_keep_each_application_sender(self):
        bus = MessageBus.__new__(MessageBus)
        replies = ReplyCollector()
        handler = bus._make_method_handler(self.base, method(self.scope['_inhibit_impl'], 'u'))
        handler(request(':1.101', ['mpv', 'video'], 'ss'), replies)
        handler(request(':1.102', ['chrome', 'video'], 'ss'), replies)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(replies.errors, [])
        self.assertEqual([(item.application, item.sender) for item in self.base.request_map.values()],
                         [('mpv', ':1.101'), ('chrome', ':1.102')])

        # UnInhibit retains its existing cookie behavior after context isolation.
        stop = bus._make_method_handler(self.base, method(self.scope['_un_inhibit_impl']))
        stop(request(':1.101', [1], 'u'), replies)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(replies.errors, [])
        self.assertEqual([(item.application, item.sender) for item in self.base.request_map.values()],
                         [('chrome', ':1.102')])

    async def test_async_message_stays_bound_across_await_and_exception(self):
        observed = []
        release = asyncio.Event()

        async def read_sender(interface):
            first = ServiceInterface.get_current_message().sender
            await release.wait()
            observed.append((first, ServiceInterface.get_current_message().sender))
            if first == ':1.101':
                raise ValueError('request failed')

        bus = MessageBus.__new__(MessageBus)
        replies = ReplyCollector()
        handler = bus._make_method_handler(None, method(read_sender))
        handler(request(':1.101'), replies)
        handler(request(':1.102'), replies)
        await asyncio.sleep(0)
        release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(observed, [(':1.101', ':1.101'), (':1.102', ':1.102')])
        self.assertEqual(len(replies.errors), 1)
        self.assertIsInstance(replies.errors[0], ValueError)
        self.assertIsNone(ServiceInterface.get_current_message())

    async def test_nested_synchronous_dispatch_restores_outer_message(self):
        observed = []
        bus = BaseMessageBus.__new__(BaseMessageBus)
        replies = ReplyCollector()

        def inner(interface):
            observed.append(ServiceInterface.get_current_message().sender)
            raise ValueError('inner request failed')

        inner_handler = bus._make_method_handler(None, method(inner))

        def outer(interface):
            observed.append(ServiceInterface.get_current_message().sender)
            with self.assertRaises(ValueError):
                inner_handler(request(':1.102'), replies)
            observed.append(ServiceInterface.get_current_message().sender)

        bus._make_method_handler(None, method(outer))(request(':1.101'), replies)
        self.assertEqual(observed, [':1.101', ':1.102', ':1.101'])
        self.assertIsNone(ServiceInterface.get_current_message())


if __name__ == '__main__':
    unittest.main()
