import struct
import unittest
import asyncio
import time
from unittest.mock import patch

from process_events import (
    CN_IDX_PROC,
    CN_VAL_PROC,
    PROC_CN_MCAST_LISTEN,
    PROC_EVENT_EXEC,
    build_subscription_message,
    parse_process_event,
    parse_process_event_type,
    ProcessEventSource,
)


class ProcessEventTests(unittest.TestCase):
    def test_builds_proc_connector_subscription_message(self):
        message = build_subscription_message(PROC_CN_MCAST_LISTEN, process_id=42)
        length, message_type, _, _, process_id = struct.unpack_from("=IHHII", message)
        index, value, _, _, payload_length, _ = struct.unpack_from("=IIIIHH", message, 16)
        operation = struct.unpack_from("=I", message, 36)[0]

        self.assertEqual(length, len(message))
        self.assertEqual(message_type, 3)
        self.assertEqual(process_id, 42)
        self.assertEqual((index, value), (CN_IDX_PROC, CN_VAL_PROC))
        self.assertEqual(payload_length, 4)
        self.assertEqual(operation, PROC_CN_MCAST_LISTEN)

    def test_reads_process_event_type_and_rejects_short_messages(self):
        message = bytes(36) + struct.pack("=I", PROC_EVENT_EXEC) + bytes(12) + struct.pack("=I", 321)
        self.assertEqual(parse_process_event_type(message), PROC_EVENT_EXEC)
        self.assertEqual(parse_process_event(message), (PROC_EVENT_EXEC, 321))
        self.assertIsNone(parse_process_event_type(bytes(39)))
        self.assertIsNone(parse_process_event(bytes(39)))


def event_packet(sequence=0, cpu=0, what=PROC_EVENT_EXEC, value=321):
    payload = struct.pack('=IIIIHH', CN_IDX_PROC, CN_VAL_PROC, sequence, 0, 20, 0)
    payload += struct.pack('=IIQI', what, cpu, 0, value)
    return struct.pack('=IHHII', 16 + len(payload), 3, 0, 0, 0) + payload


class ProcessEventReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def receive(self, source, packet):
        loop = asyncio.get_running_loop()
        async def recv(*args):
            await asyncio.sleep(0)
            return packet
        with patch.object(loop, 'sock_recv', side_effect=recv):
            return await asyncio.wait_for(source.wait_for_process_change(), .1)

    def source(self):
        source = ProcessEventSource()
        source.socket = object()
        return source

    async def test_sequence_gap_is_reported_to_enable_polling_fallback(self):
        source = self.source()
        self.assertEqual(await self.receive(source, event_packet(sequence=4)), (PROC_EVENT_EXEC, 321))
        with self.assertRaises(ConnectionError):
            await self.receive(source, event_packet(sequence=6))

    async def test_sequences_are_independent_per_cpu_and_wrap(self):
        source = self.source()
        for sequence, cpu in [(0xffffffff, 0), (30, 1), (0, 0), (31, 1)]:
            self.assertEqual(await self.receive(source, event_packet(sequence=sequence, cpu=cpu)), (PROC_EVENT_EXEC, 321))

    async def test_subscription_rejection_is_not_silently_ignored(self):
        with self.assertRaises(ConnectionError):
            await self.receive(self.source(), event_packet(what=0, value=1))

    async def test_truncated_event_is_not_silently_ignored(self):
        with self.assertRaises(ConnectionError):
            await self.receive(self.source(), event_packet()[:40])

    async def test_current_kernel_ack_participates_in_sequence(self):
        source = self.source()
        await self.receive(source, event_packet(sequence=4))
        await self.receive(source, event_packet(sequence=5, what=0, value=0))
        self.assertEqual(await self.receive(source, event_packet(sequence=6)), (PROC_EVENT_EXEC, 321))

    async def test_legacy_ack_does_not_reset_cpu_sequence(self):
        source = self.source()
        await self.receive(source, event_packet(sequence=4))
        await self.receive(source, event_packet(sequence=0, cpu=0xffffffff, what=0, value=0))
        self.assertTrue(source.subscription_confirmed)
        self.assertEqual(await self.receive(source, event_packet(sequence=5)), (PROC_EVENT_EXEC, 321))

    async def test_silent_subscription_times_out_instead_of_waiting_forever(self):
        source = self.source()
        source._subscription_deadline = time.monotonic() + .02
        loop = asyncio.get_running_loop()
        async def recv(*args):
            await asyncio.Event().wait()
        with patch.object(loop, 'sock_recv', side_effect=recv):
            with self.assertRaises(ConnectionError):
                await asyncio.wait_for(source.wait_for_process_change(), .2)


if __name__ == "__main__":
    unittest.main()
