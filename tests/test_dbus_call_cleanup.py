import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'defaults'))

from dbus_next import Message
from dbus_next.aio import MessageBus
from dbus_next.constants import MessageFlag
from dbus_next.message_bus import BaseMessageBus


def request(flags=MessageFlag.NONE):
    return Message(destination='org.mpris.MediaPlayer2.test', path='/org/mpris/MediaPlayer2',
                   interface='org.freedesktop.DBus.Properties', member='GetAll', flags=flags)


class DbusCallCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Keep the real call/_call/reply dispatch; replace only the socket writer.
        self.bus = MessageBus.__new__(MessageBus)
        self.bus._loop = asyncio.get_running_loop()
        self.bus._serial = 0
        self.bus._method_return_handlers = {}
        self.bus._name_owners = {}
        self.bus._user_message_handlers = []
        self.bus._path_exports = {}
        self.bus._disconnected = False
        self.sent = []
        self.send_futures = []

        def send(msg):
            self.sent.append(msg)
            future = self.bus._loop.create_future()
            self.send_futures.append(future)
            return future

        self.bus.send = send

    async def start_call(self, msg):
        task = asyncio.create_task(self.bus.call(msg))
        await asyncio.sleep(0)
        return task

    async def test_repeated_timeouts_remove_each_pending_handler(self):
        for _ in range(10):
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(self.bus.call(request()), 0.005)
        self.assertEqual(len(self.sent), 10)
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_cancel_pending_send_cannot_register_a_handler_later(self):
        msg = request()
        task = await self.start_call(msg)
        self.assertIn(msg.serial, self.bus._method_return_handlers)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.bus._method_return_handlers, {})
        # Base._call registers synchronously, independently of send completion.
        self.send_futures[0].set_result(None)
        await asyncio.sleep(0)
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_late_reply_after_cancel_is_ignored(self):
        msg = request()
        task = await self.start_call(msg)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.bus._process_message(Message.new_method_return(msg))
        self.assertEqual(self.bus._method_return_handlers, {})
        self.assertEqual(self.bus._name_owners, {})

    async def test_cancel_preserves_a_replacement_handler_at_same_serial(self):
        msg = request()
        task = await self.start_call(msg)
        replacement = lambda reply, error: None
        self.bus._method_return_handlers[msg.serial] = replacement
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIs(self.bus._method_return_handlers[msg.serial], replacement)

    async def test_normal_reply_returns_message_and_removes_handler(self):
        msg = request()
        task = await self.start_call(msg)
        reply = Message.new_method_return(msg)
        self.bus._process_message(reply)
        self.assertIs(await task, reply)
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_dbus_error_reply_still_returns_error_message(self):
        msg = request()
        task = await self.start_call(msg)
        reply = Message.new_error(msg, 'org.freedesktop.DBus.Error.Failed', 'failed')
        self.bus._process_message(reply)
        self.assertIs(await task, reply)
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_transport_error_removes_handler_and_raises(self):
        msg = request()
        task = await self.start_call(msg)
        self.bus._method_return_handlers[msg.serial](None, ConnectionError('lost connection'))
        with self.assertRaisesRegex(ConnectionError, 'lost connection'):
            await task
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_disconnect_finalization_rejects_and_clears_pending_calls(self):
        task = await self.start_call(request())
        BaseMessageBus._finalize(self.bus, ConnectionError('disconnected'))
        with self.assertRaisesRegex(ConnectionError, 'disconnected'):
            await task
        self.assertEqual(self.bus._method_return_handlers, {})

    async def test_no_reply_and_signal_wait_for_send_without_registering(self):
        for msg in [request(MessageFlag.NO_REPLY_EXPECTED),
                    Message.new_signal('/test', 'org.test.Interface', 'Changed')]:
            task = await self.start_call(msg)
            self.assertFalse(task.done())
            self.assertEqual(self.bus._method_return_handlers, {})
            self.send_futures[-1].set_result(None)
            self.assertIsNone(await task)


if __name__ == '__main__':
    unittest.main()
