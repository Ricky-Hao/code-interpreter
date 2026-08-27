#!/usr/bin/env python3
import contextlib
import json
import os
import re
import signal
import socketserver
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


SOCKET_ROOT = Path(os.environ.get("PASST_SOCKET_ROOT", "/run/codeapi-passt"))
CONTROL_SOCKET = SOCKET_ROOT / "control.sock"
VM_ID_PATTERN = re.compile(r"^vm-[a-z0-9]{8}$")


class PasstSupervisor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._processes: dict[str, subprocess.Popen[bytes]] = {}

    def start(self, vm_id: str, host_port: int, guest_port: int) -> None:
        self._validate(vm_id, host_port, guest_port)
        socket_path = SOCKET_ROOT / f"{vm_id}.sock"
        with self._lock:
            existing = self._processes.get(vm_id)
            if existing is not None and existing.poll() is None:
                raise ValueError("VM network already exists")
            socket_path.unlink(missing_ok=True)
            process = subprocess.Popen(
                [
                    "/usr/bin/passt",
                    "--foreground",
                    "--quiet",
                    "--one-off",
                    "--chroot-fallback",
                    "--ipv4-only",
                    "--socket",
                    str(socket_path),
                    "--tcp-ports",
                    f"{host_port}:{guest_port}",
                ],
                stdin=subprocess.DEVNULL,
            )
            self._processes[vm_id] = process

        deadline = time.monotonic() + 5
        while not socket_path.exists() or not self._ipv4_listener_exists(host_port):
            status = process.poll()
            if status is not None:
                self._forget(vm_id, process)
                raise RuntimeError(f"passt exited before readiness with status {status}")
            if time.monotonic() >= deadline:
                self.stop(vm_id)
                raise TimeoutError("timed out waiting for passt socket")
            time.sleep(0.02)

        threading.Thread(target=self._reap, args=(vm_id, process, socket_path), daemon=True).start()

    def stop(self, vm_id: str) -> None:
        if not VM_ID_PATTERN.fullmatch(vm_id):
            raise ValueError("invalid VM ID")
        with self._lock:
            process = self._processes.pop(vm_id, None)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        (SOCKET_ROOT / f"{vm_id}.sock").unlink(missing_ok=True)

    def close(self) -> None:
        with self._lock:
            vm_ids = list(self._processes)
        for vm_id in vm_ids:
            self.stop(vm_id)

    @staticmethod
    def _validate(vm_id: str, host_port: int, guest_port: int) -> None:
        if not VM_ID_PATTERN.fullmatch(vm_id):
            raise ValueError("invalid VM ID")
        if not 1 <= host_port <= 65535 or not 1 <= guest_port <= 65535:
            raise ValueError("invalid port")

    @staticmethod
    def _ipv4_listener_exists(port: int) -> bool:
        expected_port = f"{port:04X}"
        try:
            lines = Path("/proc/net/tcp").read_text().splitlines()[1:]
        except OSError:
            return False
        return any(
            fields[1].rsplit(":", 1)[-1] == expected_port and fields[3] == "0A"
            for line in lines
            if len(fields := line.split()) >= 4
        )

    def _forget(self, vm_id: str, process: subprocess.Popen[bytes]) -> None:
        with self._lock:
            if self._processes.get(vm_id) is process:
                self._processes.pop(vm_id, None)

    def _reap(self, vm_id: str, process: subprocess.Popen[bytes], socket_path: Path) -> None:
        process.wait()
        self._forget(vm_id, process)
        socket_path.unlink(missing_ok=True)


SUPERVISOR = PasstSupervisor()


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        try:
            request: dict[str, Any] = json.loads(self.rfile.readline(4096))
            action = request.get("action")
            vm_id = request.get("vm_id")
            if not isinstance(vm_id, str):
                raise ValueError("vm_id is required")
            if action == "start":
                host_port = request.get("host_port")
                guest_port = request.get("guest_port")
                if not isinstance(host_port, int) or isinstance(host_port, bool):
                    raise ValueError("host_port must be an integer")
                if not isinstance(guest_port, int) or isinstance(guest_port, bool):
                    raise ValueError("guest_port must be an integer")
                SUPERVISOR.start(vm_id, host_port, guest_port)
            elif action == "stop":
                SUPERVISOR.stop(vm_id)
            else:
                raise ValueError("invalid action")
            response = {"ok": True}
        except Exception as error:
            response = {"ok": False, "error": str(error)}
        self.wfile.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")


class ControlServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main() -> None:
    SOCKET_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    CONTROL_SOCKET.unlink(missing_ok=True)
    server = ControlServer(str(CONTROL_SOCKET), ControlHandler)
    os.chmod(CONTROL_SOCKET, 0o600)

    def shutdown(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        SUPERVISOR.close()
        CONTROL_SOCKET.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
