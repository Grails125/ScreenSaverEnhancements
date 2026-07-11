import asyncio
import os
import socket
import struct


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

    async def wait_for_process_change(self):
        if self.socket is None:
            raise RuntimeError("Process event source is not open")
        loop = asyncio.get_running_loop()
        while True:
            message = await loop.sock_recv(self.socket, 4096)
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
