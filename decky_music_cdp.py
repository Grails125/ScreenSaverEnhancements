import base64
import hashlib
import json
import os
import socket
import struct
from urllib.parse import urlparse
from urllib.request import urlopen


DECKY_CDP_ADDRESS = ("127.0.0.1", 8080)
DECKY_CDP_TARGET_TITLE = "SharedJSContext"
DECKY_MUSIC_TRACKER_KEY = "__screenSaverEnhancementsDeckyMusicTrackerV1"
DECKY_MUSIC_TRACKER_SCRIPT = r'''
(() => {
  const key = "__screenSaverEnhancementsDeckyMusicTrackerV1";
  const existing = globalThis[key];
  if (existing && existing.version === 1) return true;

  const tracked = new Set();
  const mediaPrototype = HTMLMediaElement.prototype;
  const originalPlay = mediaPrototype.play;
  const originalPause = mediaPrototype.pause;
  const remove = function() { tracked.delete(this); };
  const track = (audio) => {
    if (!audio || tracked.has(audio)) return audio;
    tracked.add(audio);
    audio.addEventListener("pause", remove, { once: true });
    audio.addEventListener("ended", remove, { once: true });
    return audio;
  };

  mediaPrototype.play = function(...args) {
    track(this);
    return originalPlay.apply(this, args);
  };
  mediaPrototype.pause = function(...args) {
    track(this);
    return originalPause.apply(this, args);
  };
  globalThis[key] = {
    version: 1,
    trackAll(audioObjects) {
      for (const audio of audioObjects) track(audio);
      return this.isPlaying();
    },
    isPlaying() {
      for (const audio of tracked) {
        if (!audio.paused && !audio.ended && audio.readyState > 0) return true;
      }
      return false;
    },
  };
  return true;
})()
'''


def _recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ConnectionError("Chrome DevTools connection closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_websocket_text(sock, payload):
    data = payload.encode("utf-8")
    mask = os.urandom(4)
    size = len(data)
    if size < 126:
        header = bytes((0x81, 0x80 | size))
    elif size <= 0xFFFF:
        header = bytes((0x81, 0x80 | 126)) + struct.pack("!H", size)
    else:
        header = bytes((0x81, 0x80 | 127)) + struct.pack("!Q", size)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
    sock.sendall(header + mask + masked)


def _recv_websocket_text(sock):
    while True:
        first, second = _recv_exact(sock, 2)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", _recv_exact(sock, 2))[0]
        elif size == 127:
            size = struct.unpack("!Q", _recv_exact(sock, 8))[0]
        mask = _recv_exact(sock, 4) if masked else b""
        data = _recv_exact(sock, size)
        if masked:
            data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
        if opcode == 0x8:
            raise ConnectionError("Chrome DevTools WebSocket closed")
        if opcode == 0x9:
            sock.sendall(bytes((0x8A, len(data))) + data)
            continue
        if opcode == 0x1:
            return data.decode("utf-8")


def _open_cdp_websocket(websocket_url):
    parsed = urlparse(websocket_url)
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port != DECKY_CDP_ADDRESS[1]
        or not parsed.path.startswith("/devtools/page/")
    ):
        raise ValueError("Unexpected Chrome DevTools endpoint")
    sock = socket.create_connection(DECKY_CDP_ADDRESS, timeout=6)
    sock.settimeout(6)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {parsed.path} HTTP/1.1\r\n"
        f"Host: {DECKY_CDP_ADDRESS[0]}:{DECKY_CDP_ADDRESS[1]}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: http://localhost\r\n\r\n"
    )
    sock.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(1024)
        if not chunk:
            raise ConnectionError("Chrome DevTools closed during handshake")
        response += chunk
        if len(response) > 16 * 1024:
            raise ConnectionError("Invalid Chrome DevTools handshake")
    headers, _ = response.split(b"\r\n\r\n", 1)
    expected_accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest(),
    ).decode("ascii")
    if b" 101 " not in headers.splitlines()[0] or expected_accept.encode("ascii") not in headers:
        sock.close()
        raise ConnectionError("Chrome DevTools WebSocket handshake failed")
    return sock


def _call_cdp(sock, request_id, method_name, params):
    _send_websocket_text(sock, json.dumps({
        "id": request_id,
        "method": method_name,
        "params": params,
    }, separators=(",", ":")))
    while True:
        message = json.loads(_recv_websocket_text(sock))
        if message.get("id") != request_id:
            continue
        if "error" in message:
            raise RuntimeError(message["error"].get("message", "Chrome DevTools error"))
        return message["result"]


def _read_decky_music_tracker(sock):
    result = _call_cdp(sock, 1, "Runtime.evaluate", {
        "expression": (
            "(() => { const tracker = globalThis["
            f"{json.dumps(DECKY_MUSIC_TRACKER_KEY)}"
            "]; return tracker ? tracker.isPlaying() : null; })()"
        ),
        "returnByValue": True,
    })
    value = result["result"].get("value")
    return value if isinstance(value, bool) else None


def _install_decky_music_tracker(sock):
    installed = _call_cdp(sock, 2, "Runtime.evaluate", {
        "expression": DECKY_MUSIC_TRACKER_SCRIPT,
        "returnByValue": True,
    })["result"].get("value")
    if installed is not True:
        raise RuntimeError("Could not install DeckyMusic playback tracker")

    prototype = _call_cdp(sock, 3, "Runtime.evaluate", {
        "expression": "HTMLAudioElement.prototype",
    })["result"]["objectId"]
    audio_objects = _call_cdp(sock, 4, "Runtime.queryObjects", {
        "prototypeObjectId": prototype,
    })["objects"]["objectId"]
    result = _call_cdp(sock, 5, "Runtime.callFunctionOn", {
        "objectId": audio_objects,
        "functionDeclaration": (
            "function() { return globalThis["
            f"{json.dumps(DECKY_MUSIC_TRACKER_KEY)}"
            "].trackAll(this); }"
        ),
        "returnByValue": True,
    })
    return result["result"].get("value") is True


def is_playing():
    """Fallback playback detection for older Decky Music releases without MPRIS."""
    with urlopen("http://127.0.0.1:8080/json", timeout=2) as response:
        targets = json.load(response)
    target = next(
        (item for item in targets if item.get("title") == DECKY_CDP_TARGET_TITLE),
        None,
    )
    if not target or not isinstance(target.get("webSocketDebuggerUrl"), str):
        return False
    sock = _open_cdp_websocket(target["webSocketDebuggerUrl"])
    try:
        playback_state = _read_decky_music_tracker(sock)
        return _install_decky_music_tracker(sock) if playback_state is None else playback_state
    finally:
        sock.close()
