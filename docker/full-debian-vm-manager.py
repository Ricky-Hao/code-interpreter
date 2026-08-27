#!/usr/bin/env python3
import contextlib
import dataclasses
import http.client
import http.server
import json
import os
import queue
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping
from pathlib import Path


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
VM_CONTROL_HEADER = "X-CodeAPI-VM-Control-Token"
VM_CONTROL_ENV = "SANDBOX_VM_CONTROL_TOKEN"


def positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = int(raw)
    if value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


@dataclasses.dataclass(frozen=True)
class ManagerConfig:
    bind_host: str = "0.0.0.0"
    bind_port: int = 2000
    max_concurrent_vms: int = 2
    vm_port_start: int = 21000
    scratch_directory: str = "/tmp/codeapi-vms"
    scratch_size_mib: int = 8192
    boot_timeout_seconds: int = 45
    request_timeout_seconds: int = 180
    shutdown_timeout_seconds: int = 5
    admission_timeout_seconds: int = 5
    max_request_bytes: int = 64 * 1024 * 1024
    max_response_bytes: int = 64 * 1024 * 1024
    launcher_path: str = "/usr/local/bin/launcher-entrypoint.sh"
    passt_control_socket: str = "/run/codeapi-passt/control.sock"

    @classmethod
    def from_env(cls) -> "ManagerConfig":
        return cls(
            bind_host=os.environ.get("SANDBOX_VM_MANAGER_HOST", "0.0.0.0"),
            bind_port=positive_int("PORT", 2000),
            max_concurrent_vms=positive_int("SANDBOX_VM_MAX_CONCURRENT", 2),
            vm_port_start=positive_int("SANDBOX_VM_PORT_START", 21000),
            scratch_directory=os.environ.get("SANDBOX_VM_SCRATCH_DIRECTORY", "/tmp/codeapi-vms"),
            scratch_size_mib=positive_int("SANDBOX_VM_SCRATCH_SIZE_MIB", 8192),
            boot_timeout_seconds=positive_int("SANDBOX_VM_BOOT_TIMEOUT_SECONDS", 45),
            request_timeout_seconds=positive_int("SANDBOX_VM_REQUEST_TIMEOUT_SECONDS", 180),
            shutdown_timeout_seconds=positive_int("SANDBOX_VM_SHUTDOWN_TIMEOUT_SECONDS", 5),
            admission_timeout_seconds=positive_int("SANDBOX_VM_ADMISSION_TIMEOUT_SECONDS", 5),
            max_request_bytes=positive_int("SANDBOX_VM_MAX_REQUEST_BYTES", 64 * 1024 * 1024),
            max_response_bytes=positive_int("SANDBOX_VM_MAX_RESPONSE_BYTES", 64 * 1024 * 1024),
            launcher_path=os.environ.get("SANDBOX_VM_LAUNCHER", "/usr/local/bin/launcher-entrypoint.sh"),
            passt_control_socket=os.environ.get(
                "SANDBOX_VM_PASST_CONTROL_SOCKET", "/run/codeapi-passt/control.sock"
            ),
        )


@dataclasses.dataclass(frozen=True)
class ProxyResponse:
    status: int
    reason: str
    headers: tuple[tuple[str, str], ...]
    body: bytes


class VmCapacityError(RuntimeError):
    pass


class PortPool:
    def __init__(self, start: int, count: int):
        if start + count - 1 > 65535:
            raise ValueError("MicroVM host port range exceeds 65535")
        self._ports: queue.Queue[int] = queue.Queue(maxsize=count)
        for port in range(start, start + count):
            self._ports.put(port)

    @contextlib.contextmanager
    def lease(self, timeout_seconds: int | None = None):
        try:
            port = self._ports.get(timeout=timeout_seconds)
        except queue.Empty as error:
            raise VmCapacityError("all MicroVM execution slots are busy") from error
        try:
            yield port
        finally:
            self._ports.put(port)


def create_ext4_scratch(path: Path, size_mib: int) -> None:
    subprocess.run(["truncate", "-s", f"{size_mib}M", str(path)], check=True)
    subprocess.run(
        ["mkfs.ext4", "-q", "-O", "^has_journal", "-L", "codeapi-scratch", str(path)],
        check=True,
    )


class VmManager:
    def __init__(
        self,
        config: ManagerConfig,
        disk_builder: Callable[[Path, int], None] = create_ext4_scratch,
    ):
        self.config = config
        self._disk_builder = disk_builder
        self._ports = PortPool(config.vm_port_start, config.max_concurrent_vms)
        self._active = 0
        self._active_lock = threading.Lock()
        self._scratch_root = Path(config.scratch_directory)
        self._scratch_root.mkdir(parents=True, exist_ok=True)
        for stale_directory in self._scratch_root.glob("vm-*"):
            if stale_directory.is_dir():
                shutil.rmtree(stale_directory, ignore_errors=True)

    @property
    def active(self) -> int:
        with self._active_lock:
            return self._active

    def health(self) -> bytes:
        return json.dumps(
            {
                "status": "ok",
                "mode": "full-debian-per-request-microvm",
                "capacity": self.config.max_concurrent_vms,
                "active": self.active,
            },
            separators=(",", ":"),
        ).encode()

    def proxy(
        self,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> ProxyResponse:
        with self.execution_slot() as host_port:
            return self.proxy_in_slot(host_port, method, path, headers, body)

    @contextlib.contextmanager
    def execution_slot(self):
        with self._ports.lease(self.config.admission_timeout_seconds) as host_port:
            with self._active_lock:
                self._active += 1
            try:
                yield host_port
            finally:
                with self._active_lock:
                    self._active -= 1

    def proxy_in_slot(
        self,
        host_port: int,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> ProxyResponse:
        return self._proxy_in_vm(host_port, method, path, headers, body)

    def _proxy_in_vm(
        self,
        host_port: int,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> ProxyResponse:
        vm_id = f"vm-{secrets.token_hex(4)}"
        vm_directory = Path(tempfile.mkdtemp(prefix=f"{vm_id}-", dir=self._scratch_root))
        scratch_disk = vm_directory / "scratch.ext4"
        control_token = secrets.token_urlsafe(32)
        process: subprocess.Popen[bytes] | None = None
        try:
            self._disk_builder(scratch_disk, self.config.scratch_size_mib)
            self._control_passt("start", vm_id, host_port)
            environment = os.environ.copy()
            environment.update(
                {
                    "PORT": "2000",
                    "LAUNCHER_NETWORK_BACKEND": "passt",
                    "LAUNCHER_PASST_SOCKET": f"/run/codeapi-passt/{vm_id}.sock",
                    "LAUNCHER_PORT_MAP": f"{host_port}:2000",
                    "LAUNCHER_SCRATCH_DISK": str(scratch_disk),
                    "CODEAPI_HARDENED_SANDBOX_MODE": "false",
                    "SANDBOX_FULL_DEBIAN_MODE": "true",
                    "SANDBOX_MAX_CONCURRENT_JOBS": "1",
                    "SANDBOX_JOB_UID_COUNT": "1",
                    "SANDBOX_PER_JOB_UIDS": "false",
                    "SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP": "false",
                    VM_CONTROL_ENV: control_token,
                }
            )
            process = subprocess.Popen(
                [self.config.launcher_path],
                env=environment,
                start_new_session=True,
            )
            self._wait_for_guest(process, host_port, control_token)
            return self._forward(host_port, method, path, headers, body, control_token)
        finally:
            if process is not None:
                self._stop_vm(process)
            with contextlib.suppress(Exception):
                self._control_passt("stop", vm_id)
            shutil.rmtree(vm_directory, ignore_errors=True)

    def _control_passt(self, action: str, vm_id: str, host_port: int | None = None) -> None:
        request: dict[str, object] = {"action": action, "vm_id": vm_id}
        if action == "start":
            request.update({"host_port": host_port, "guest_port": 2000})
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(6)
            connection.connect(self.config.passt_control_socket)
            connection.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
            response = b""
            while not response.endswith(b"\n"):
                chunk = connection.recv(4096)
                if not chunk:
                    raise RuntimeError("passt supervisor closed the control connection")
                response += chunk
                if len(response) > 4096:
                    raise RuntimeError("passt supervisor response is too large")
        result = json.loads(response)
        if result.get("ok") is not True:
            raise RuntimeError(f"passt supervisor rejected {action}: {result.get('error', 'unknown error')}")

    def _wait_for_guest(self, process: subprocess.Popen[bytes], host_port: int, control_token: str) -> None:
        deadline = time.monotonic() + self.config.boot_timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            return_code = process.poll()
            if return_code is not None:
                raise RuntimeError(f"MicroVM launcher exited before readiness with status {return_code}")
            connection = http.client.HTTPConnection("127.0.0.1", host_port, timeout=1)
            try:
                connection.request("GET", "/api/v2/health", headers={VM_CONTROL_HEADER: control_token})
                response = connection.getresponse()
                response.read()
                if response.status == 200:
                    return
            except (ConnectionError, OSError, TimeoutError, http.client.HTTPException) as error:
                last_error = error
            finally:
                connection.close()
            time.sleep(0.05)
        raise TimeoutError(f"MicroVM did not become ready on port {host_port}: {last_error}")

    def _forward(
        self,
        host_port: int,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        control_token: str,
    ) -> ProxyResponse:
        forwarded_headers = {
            key: value
            for key, value in headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS
            and key.lower() not in {"host", "content-length", VM_CONTROL_HEADER.lower()}
        }
        forwarded_headers["Content-Length"] = str(len(body))
        forwarded_headers["Host"] = f"127.0.0.1:{host_port}"
        forwarded_headers[VM_CONTROL_HEADER] = control_token
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            host_port,
            timeout=self.config.request_timeout_seconds,
        )
        try:
            connection.request(method, path, body=body, headers=forwarded_headers)
            response = connection.getresponse()
            response_body = response.read(self.config.max_response_bytes + 1)
            if len(response_body) > self.config.max_response_bytes:
                raise RuntimeError("MicroVM response exceeds manager limit")
            response_headers = tuple(
                (key, value)
                for key, value in response.getheaders()
                if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length"
            )
            return ProxyResponse(
                status=response.status,
                reason=response.reason,
                headers=response_headers,
                body=response_body,
            )
        finally:
            connection.close()

    def _stop_vm(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=self.config.shutdown_timeout_seconds)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def validate_host(config: ManagerConfig) -> None:
    errors: list[str] = []
    launcher = Path(config.launcher_path)
    root_disk = Path(os.environ.get("LAUNCHER_ROOT_DISK", "/sandbox-rootfs.img"))
    kvm = Path(os.environ.get("SANDBOX_VM_KVM_DEVICE", "/dev/kvm"))
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        errors.append(f"launcher is not executable: {launcher}")
    if not root_disk.is_file():
        errors.append(f"root disk is unavailable: {root_disk}")
    if not kvm.exists():
        errors.append(f"KVM device is unavailable: {kvm}")
    for command in ("truncate", "mkfs.ext4"):
        if shutil.which(command) is None:
            errors.append(f"required command is unavailable: {command}")
    if errors:
        raise RuntimeError("; ".join(errors))


class ManagerHttpServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], manager: VmManager):
        self.manager = manager
        super().__init__(address, ManagerRequestHandler)


class ManagerRequestHandler(http.server.BaseHTTPRequestHandler):
    server: ManagerHttpServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/v2/health":
            self._write_response(200, "OK", (("Content-Type", "application/json"),), self.server.manager.health())
            return
        self._proxy_request()

    def do_HEAD(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/v2/health":
            self._write_response(200, "OK", (("Content-Type", "application/json"),), b"")
            return
        self._proxy_request()

    def do_POST(self) -> None:
        self._proxy_request()

    def do_PUT(self) -> None:
        self._proxy_request()

    def do_DELETE(self) -> None:
        self._proxy_request()

    def _proxy_request(self) -> None:
        if self.command != "POST" or urllib.parse.urlsplit(self.path).path != "/api/v2/execute":
            self._json_error(404, "unsupported sandbox endpoint")
            return
        transfer_encoding = self.headers.get("Transfer-Encoding")
        content_lengths = self.headers.get_all("Content-Length", [])
        if transfer_encoding is not None:
            self._json_error(400, "Transfer-Encoding is not supported")
            return
        if len(content_lengths) > 1:
            self._json_error(400, "ambiguous Content-Length")
            return
        try:
            content_length = int(content_lengths[0]) if content_lengths else 0
        except ValueError:
            self._json_error(400, "invalid Content-Length")
            return
        if content_length < 0:
            self._json_error(400, "invalid Content-Length")
            return
        if content_length > self.server.manager.config.max_request_bytes:
            self._json_error(413, "request body exceeds manager limit")
            return
        try:
            with self.server.manager.execution_slot() as host_port:
                body = self.rfile.read(content_length) if content_length else b""
                if len(body) != content_length:
                    self._json_error(400, "incomplete request body")
                    return
                response = self.server.manager.proxy_in_slot(
                    host_port,
                    self.command,
                    self.path,
                    dict(self.headers.items()),
                    body,
                )
        except VmCapacityError as error:
            self._json_error(503, str(error))
            return
        except TimeoutError as error:
            self._json_error(504, str(error))
            return
        except Exception as error:
            self.log_error("MicroVM request failed: %s", error)
            self._json_error(502, "MicroVM request failed")
            return
        self._write_response(response.status, response.reason, response.headers, response.body)

    def _json_error(self, status: int, message: str) -> None:
        body = json.dumps({"message": message}, separators=(",", ":")).encode()
        self._write_response(status, http.client.responses[status], (("Content-Type", "application/json"),), body)

    def _write_response(
        self,
        status: int,
        reason: str,
        headers: tuple[tuple[str, str], ...],
        body: bytes,
    ) -> None:
        self.send_response(status, reason)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main() -> None:
    config = ManagerConfig.from_env()
    validate_host(config)
    manager = VmManager(config)
    server = ManagerHttpServer((config.bind_host, config.bind_port), manager)
    print(
        f"[vm-manager] listening on {config.bind_host}:{config.bind_port}; "
        f"capacity={config.max_concurrent_vms}",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()