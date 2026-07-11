import struct
import unittest

from process_events import (
    CN_IDX_PROC,
    CN_VAL_PROC,
    PROC_CN_MCAST_LISTEN,
    PROC_EVENT_EXEC,
    build_subscription_message,
    parse_process_event_type,
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
        message = bytes(36) + struct.pack("=I", PROC_EVENT_EXEC)
        self.assertEqual(parse_process_event_type(message), PROC_EVENT_EXEC)
        self.assertIsNone(parse_process_event_type(bytes(39)))


if __name__ == "__main__":
    unittest.main()
