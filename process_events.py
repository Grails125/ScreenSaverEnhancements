import asyncio
import os
import socket
import struct
import time


NETLINK_CONNECTOR = 11
CN_IDX_PROC = 1
CN_VAL_PROC = 1
PROC_CN_MCAST_LISTEN = 1
PROC_CN_MCAST_IGNORE = 2
PROC_EVENT_EXEC = 0x00000002
PROC_EVENT_EXIT = 0x80000000
NLMSG_DONE = 3


def build_subscription_message(operation, process_id=None):
    process_id = os.getpid() if process_id is None else process_id
    connector = struct.pack("=IIIIHH", CN_IDX_PROC, CN_VAL_PROC, 0, 0, 4, 0)
    payload = connector + struct.pack("=I", operation)
    header = struct.pack("=IHHII", 16 + len(payload), NLMSG_DONE, 0, 0, process_id)
    return header + payload


def parse_process_event_type(message):
    event_offset = 16 + 20
    if len(message) < event_offset + 4:
        return None
    return struct.unpack_from("=I", message, event_offset)[0]


def parse_process_event(message):
    event_type = parse_process_event_type(message)
    process_data_offset = 16 + 20 + 16
    if event_type is None or len(message) < process_data_offset + 4:
        return None
    process_id = struct.unpack_from("=I", message, process_data_offset)[0]
    return event_type, process_id


class ProcessEventSource:
    def __init__(self):
        self.socket = None
        self._sequence_by_cpu = {}
        self.subscription_confirmed = False
        self._subscription_deadline = None

    def open(self):
        netlink = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, NETLINK_CONNECTOR)
        try:
            netlink.bind((os.getpid(), CN_IDX_PROC))
            netlink.send(build_subscription_message(PROC_CN_MCAST_LISTEN))
            netlink.setblocking(False)
        except Exception:
            netlink.close()
            raise
        self.socket = netlink
        self._sequence_by_cpu.clear()
        self.subscription_confirmed = False
        self._subscription_deadline = time.monotonic() + 3.0

    async def wait_for_process_change(self):
        if self.socket is None:
            raise RuntimeError("Process event source is not open")
        loop = asyncio.get_running_loop()
        while True:
            if self.subscription_confirmed:
                message = await loop.sock_recv(self.socket, 4096)
            else:
                if self._subscription_deadline is None:
                    self._subscription_deadline = time.monotonic() + 3.0
                remaining = max(0, self._subscription_deadline - time.monotonic())
                try:
                    message = await asyncio.wait_for(loop.sock_recv(self.socket, 4096), remaining)
                except asyncio.TimeoutError as error:
                    raise ConnectionError("Process event subscription confirmation timed out") from error
            if len(message) < 16:
                raise ConnectionError("Process event stream closed or truncated")
            length, message_type = struct.unpack_from("=IH", message)
            if length > len(message) or length < 16:
                raise ConnectionError("Truncated process event packet")
            if message_type == 2:  # NLMSG_ERROR, including subscription errors.
                if length < 20 or struct.unpack_from("=i", message, 16)[0] != 0:
                    raise ConnectionError("Process event subscription failed")
                continue
            if message_type != NLMSG_DONE:
                continue
            if length < 56:
                raise ConnectionError("Truncated process connector message")
            index, value, sequence = struct.unpack_from("=III", message, 16)
            if (index, value) != (CN_IDX_PROC, CN_VAL_PROC):
                continue
            what, cpu = struct.unpack_from("=II", message, 36)
            if what == 0:  # PROC_EVENT_NONE carries the subscription ACK.
                if struct.unpack_from("=I", message, 52)[0] != 0:
                    raise ConnectionError("Process event subscription rejected")
                self.subscription_confirmed = True
                # Older kernels echo the request seq with cpu=-1. New kernels
                # send ACKs through send_msg(), consuming a per-CPU sequence.
                if cpu == 0xffffffff:
                    return 0, 0
            # cn_proc sequences every event on its originating CPU, including
            # event types that we do not consume. A gap invalidates event-only
            # discovery: let the caller switch to polling rather than miss exec.
            previous = self._sequence_by_cpu.get(cpu)
            self._sequence_by_cpu[cpu] = sequence
            if previous is not None and sequence != (previous + 1) & 0xffffffff:
                raise ConnectionError("Process event sequence gap")
            self.subscription_confirmed = True
            if what == 0:
                return 0, 0
            event = parse_process_event(message)
            if event is not None and event[0] in (PROC_EVENT_EXEC, PROC_EVENT_EXIT):
                return event

    def close(self):
        netlink = self.socket
        self.socket = None
        if netlink is None:
            return
        try:
            netlink.send(build_subscription_message(PROC_CN_MCAST_IGNORE))
        except OSError:
            pass
        netlink.close()


if __name__ == "__main__":
    async def probe():
        source = ProcessEventSource()
        try:
            source.open()
            process = await asyncio.create_subprocess_exec("/usr/bin/true")
            event_type = await asyncio.wait_for(source.wait_for_process_change(), timeout=3)
            await process.wait()
            print(f"proc_connector:{event_type}")
        finally:
            source.close()

    asyncio.run(probe())
