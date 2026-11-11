"""Minimal dependency-free Home Assistant REST and websocket test client."""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from typing import Any


class Http:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.host = urllib.parse.urlsplit(self.base_url).hostname or "127.0.0.1"
        self.port = urllib.parse.urlsplit(self.base_url).port or 80

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        token: str | None = None,
        form: bool = False,
        expected: Iterable[int] = (200, 201),
    ) -> tuple[int, Any]:
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode()
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = resp.read()
                parsed = json.loads(payload) if payload else None
                if resp.status not in expected:
                    raise AssertionError((resp.status, path, parsed))
                return resp.status, parsed
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            parsed = json.loads(payload) if payload else None
            if exc.code in expected:
                return exc.code, parsed
            raise AssertionError((exc.code, path, parsed)) from exc

    def login(self, username: str, password: str) -> dict[str, Any]:
        client_id = self.base_url + "/"
        _, flow = self.request(
            "POST",
            "/auth/login_flow",
            {
                "client_id": client_id,
                "handler": ["homeassistant", None],
                "redirect_uri": client_id + "?auth_callback=1",
            },
        )
        _, result = self.request(
            "POST",
            f"/auth/login_flow/{flow['flow_id']}",
            {"client_id": client_id, "username": username, "password": password},
        )
        if result.get("type") != "create_entry":
            raise AssertionError(result)
        _, token = self.request(
            "POST",
            "/auth/token",
            {"grant_type": "authorization_code", "code": result["result"], "client_id": client_id},
            form=True,
        )
        return token


class WebSocket:
    def __init__(self, host: str, port: int) -> None:
        self.sock = socket.create_connection((host, port), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET /api/websocket HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        raw = b""
        while b"\r\n\r\n" not in raw:
            part = self.sock.recv(4096)
            if not part:
                raise EOFError("websocket handshake closed")
            raw += part
        header, self.buffer = raw.split(b"\r\n\r\n", 1)
        status = header.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise RuntimeError(status.decode(errors="replace"))
        self.next_id = 1

    def _recv_exact(self, count: int) -> bytes:
        while len(self.buffer) < count:
            part = self.sock.recv(65536)
            if not part:
                raise EOFError("websocket closed")
            self.buffer += part
        output, self.buffer = self.buffer[:count], self.buffer[count:]
        return output

    def _send(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        first = 0x80 | opcode
        length = len(payload)
        if length < 126:
            header = bytes((first, 0x80 | length))
        elif length < 65536:
            header = bytes((first, 0x80 | 126)) + struct.pack("!H", length)
        else:
            header = bytes((first, 0x80 | 127)) + struct.pack("!Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _recv(self) -> tuple[int, bytes]:
        first, second = self._recv_exact(2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if second & 0x80 else None
        payload = self._recv_exact(length) if length else b""
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 9:
            self._send(10, payload)
            return self._recv()
        if opcode == 8:
            raise EOFError("websocket closed")
        if opcode == 10:
            return self._recv()
        return opcode, payload

    def recv_json(self) -> dict[str, Any]:
        opcode, payload = self._recv()
        if opcode != 1:
            raise AssertionError((opcode, payload[:200]))
        return json.loads(payload)

    def send_json(self, value: dict[str, Any]) -> None:
        self._send(1, json.dumps(value).encode())

    def auth(self, token: str) -> dict[str, Any]:
        first = self.recv_json()
        if first.get("type") != "auth_required":
            raise AssertionError(first)
        self.send_json({"type": "auth", "access_token": token})
        result = self.recv_json()
        if result.get("type") != "auth_ok":
            raise AssertionError(result)
        return result

    def command(self, payload: dict[str, Any]) -> Any:
        message = dict(payload)
        message["id"] = self.next_id
        self.next_id += 1
        self.send_json(message)
        while True:
            reply = self.recv_json()
            if reply.get("id") != message["id"]:
                continue
            if reply.get("success"):
                return reply.get("result")
            raise RuntimeError((payload.get("type"), reply))

    def close(self) -> None:
        try:
            self._send(8, b"")
        finally:
            self.sock.close()


def wait_ready(http: Http, timeout: float = 180.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _, status = http.request("GET", "/api/onboarding")
            if status:
                return status
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("Home Assistant did not become ready")


def onboard(http: Http, username: str, password: str) -> str:
    _, steps = wait_ready(http)
    client_id = http.base_url + "/"
    if not next(step for step in steps if step["step"] == "user")["done"]:
        _, created = http.request(
            "POST",
            "/api/onboarding/users",
            {
                "name": "Runtime Owner",
                "username": username,
                "password": password,
                "client_id": client_id,
                "language": "en",
            },
        )
        _, tokens = http.request(
            "POST",
            "/auth/token",
            {"grant_type": "authorization_code", "code": created["auth_code"], "client_id": client_id},
            form=True,
        )
        token = tokens["access_token"]
    else:
        token = http.login(username, password)["access_token"]
    for path in ("/api/onboarding/core_config", "/api/onboarding/analytics"):
        try:
            http.request("POST", path, {}, token=token)
        except AssertionError as exc:
            if "403" not in str(exc) and "'code': 403" not in str(exc):
                raise
    try:
        http.request(
            "POST",
            "/api/onboarding/integration",
            {"client_id": client_id, "redirect_uri": client_id + "?auth_callback=1"},
            token=token,
        )
    except AssertionError as exc:
        if "403" not in str(exc) and "'code': 403" not in str(exc):
            raise
    return token
