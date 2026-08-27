#!/usr/bin/env python3
import contextlib
import importlib.util
import json
import os
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "docker" / "full-debian-vm-manager.py"
SPEC = importlib.util.spec_from_file_location("full_debian_vm_manager", MODULE_PATH)
assert SPEC and SPEC.loader
manager_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = manager_module
SPEC.loader.exec_module(manager_module)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextlib.contextmanager
def fake_passt_supervisor(path: Path):
    requests: list[dict[str, object]] = []

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            requests.append(json.loads(self.rfile.readline()))
            self.wfile.write(b'{"ok":true}\n')

    server = socketserver.ThreadingUnixStreamServer(str(path), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class FullDebianVmManagerTest(unittest.TestCase):
    def test_rootfs_precreates_overlay_mountpoint(self):
        builder = (ROOT / "docker" / "build-rootfs-image.sh").read_text()
        self.assertIn('"$rootfs/mnt/codeapi-overlay"', builder)

    def test_overlay_initializes_per_vm_debian_identity(self):
        overlay = (ROOT / "docker" / "full-debian-overlay.sh").read_text()
        self.assertIn("od -An -N16 -tx1 /dev/urandom", overlay)
        self.assertIn("> /etc/machine-id", overlay)
        self.assertIn("127.0.1.1 sandbox", overlay)
        self.assertIn("'Etc/UTC' > /etc/timezone", overlay)

    def test_full_debian_entrypoint_enables_guest_loopback(self):
        entrypoint = (ROOT / "api" / "src" / "entrypoint.sh").read_text()
        self.assertIn('SANDBOX_FULL_DEBIAN_MODE:-false', entrypoint)
        self.assertIn("ip link set lo up", entrypoint)
        self.assertIn("dhclient -4 -v -1 eth0", entrypoint)

    def test_full_debian_image_includes_coding_agent_tools(self):
        dockerfile = (ROOT / "api" / "Dockerfile").read_text()
        for package in (
            "python-is-python3",
            "yq",
            "bat",
            "fzf",
            "libxml2-utils",
            "gettext-base",
            "inotify-tools",
            "universal-ctags",
        ):
            self.assertIn(package, dockerfile)
        for command in ("bat", "ctags", "envsubst", "fzf", "inotifywait", "xmllint", "yq"):
            self.assertIn(f'command -v {command} >/dev/null', dockerfile)
        for path in ("/usr/bin/python", "/usr/bin/python3", "/usr/bin/node", "/usr/bin/nodejs"):
            self.assertIn(path, dockerfile)
        self.assertIn("pnpm@10.15.1", dockerfile)
        self.assertIn("yarn@1.22.22", dockerfile)

    def test_full_debian_manager_selects_passt_networking(self):
        manager = MODULE_PATH.read_text()
        self.assertIn('"LAUNCHER_NETWORK_BACKEND": "passt"', manager)
        self.assertIn('"LAUNCHER_PASST_SOCKET": f"/run/codeapi-passt/{vm_id}.sock"', manager)

    def test_startup_removes_stale_vm_directories(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            stale = Path(temp_dir) / "vm-stale"
            stale.mkdir()
            (stale / "scratch.ext4").write_bytes(b"stale")
            config = manager_module.ManagerConfig(scratch_directory=temp_dir)
            manager_module.VmManager(config, lambda path, size: path.touch())
            self.assertFalse(stale.exists())

    def test_health_does_not_start_a_vm(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = manager_module.ManagerConfig(scratch_directory=temp_dir)
            manager = manager_module.VmManager(config, lambda path, size: path.touch())
            self.assertEqual(
                json.loads(manager.health()),
                {
                    "status": "ok",
                    "mode": "full-debian-per-request-microvm",
                    "capacity": 2,
                    "active": 0,
                },
            )
            self.assertEqual(list(Path(temp_dir).iterdir()), [])

    def test_request_gets_an_isolated_vm_and_disposable_disk(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            launcher = temp_path / "fake-launcher.py"
            launcher.write_text(
                f"""#!{sys.executable}
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

host_port = int(os.environ['LAUNCHER_PORT_MAP'].split(':', 1)[0])
scratch = os.environ['LAUNCHER_SCRATCH_DISK']

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        expected = os.environ['SANDBOX_VM_CONTROL_TOKEN']
        if self.headers.get('X-CodeAPI-VM-Control-Token') != expected:
            self.send_response(401)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = b'{{\"status\":\"ok\"}}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        expected = os.environ['SANDBOX_VM_CONTROL_TOKEN']
        size = int(self.headers.get('Content-Length', '0'))
        request_body = self.rfile.read(size)
        body = json.dumps({{
            'request': request_body.decode(),
            'full_debian': os.environ.get('SANDBOX_FULL_DEBIAN_MODE'),
            'hardened': os.environ.get('CODEAPI_HARDENED_SANDBOX_MODE'),
            'per_job_uids': os.environ.get('SANDBOX_PER_JOB_UIDS'),
            'scratch_exists': os.path.isfile(scratch),
            'network_backend': os.environ.get('LAUNCHER_NETWORK_BACKEND'),
            'passt_socket_is_vm_local': os.environ.get('LAUNCHER_PASST_SOCKET', '').startswith('/run/codeapi-passt/vm-'),
            'control_token_valid': self.headers.get('X-CodeAPI-VM-Control-Token') == expected,
            'control_token_strong': len(expected) >= 43,
        }}).encode()
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

HTTPServer(('127.0.0.1', host_port), Handler).serve_forever()
"""
            )
            launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)

            scratch_root = temp_path / "scratch"
            config = manager_module.ManagerConfig(
                max_concurrent_vms=1,
                vm_port_start=free_port(),
                scratch_directory=str(scratch_root),
                scratch_size_mib=32,
                boot_timeout_seconds=5,
                request_timeout_seconds=5,
                shutdown_timeout_seconds=1,
                launcher_path=str(launcher),
                passt_control_socket=str(temp_path / "passt-control.sock"),
            )

            def fake_disk_builder(path: Path, size_mib: int) -> None:
                self.assertEqual(size_mib, 32)
                path.write_bytes(b"ext4-placeholder")

            manager = manager_module.VmManager(config, fake_disk_builder)
            with fake_passt_supervisor(temp_path / "passt-control.sock") as passt_requests:
                response = manager.proxy(
                    "POST",
                    "/api/v2/execute",
                    {
                        "Content-Type": "application/json",
                        "X-Test-Header": "kept",
                        "X-CodeAPI-VM-Control-Token": "caller-controlled-value",
                    },
                    b'{"language":"bash"}',
                )

            self.assertEqual(response.status, 201)
            self.assertEqual(
                json.loads(response.body),
                {
                    "request": '{"language":"bash"}',
                    "full_debian": "true",
                    "hardened": "false",
                    "per_job_uids": "false",
                    "scratch_exists": True,
                    "network_backend": "passt",
                    "passt_socket_is_vm_local": True,
                    "control_token_valid": True,
                    "control_token_strong": True,
                },
            )
            self.assertEqual(manager.active, 0)
            self.assertEqual(list(scratch_root.iterdir()), [])
            self.assertEqual([request["action"] for request in passt_requests], ["start", "stop"])
            self.assertEqual(passt_requests[0]["host_port"], config.vm_port_start)
            self.assertEqual(passt_requests[0]["guest_port"], 2000)

    def test_capacity_timeout_does_not_create_an_extra_vm(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = manager_module.ManagerConfig(
                max_concurrent_vms=1,
                vm_port_start=free_port(),
                scratch_directory=temp_dir,
                admission_timeout_seconds=1,
            )
            manager = manager_module.VmManager(config, lambda path, size: path.touch())
            with manager.execution_slot():
                self.assertEqual(manager.active, 1)
                started = time.monotonic()
                with self.assertRaises(manager_module.VmCapacityError):
                    with manager.execution_slot():
                        self.fail("capacity must not exceed one VM")
                self.assertGreaterEqual(time.monotonic() - started, 0.9)
                self.assertEqual(list(Path(temp_dir).iterdir()), [])
            self.assertEqual(manager.active, 0)

    def test_launcher_failure_removes_scratch_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            launcher = temp_path / "failed-launcher.sh"
            launcher.write_text("#!/bin/sh\nexit 23\n")
            launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)
            scratch_root = temp_path / "scratch"
            config = manager_module.ManagerConfig(
                max_concurrent_vms=1,
                vm_port_start=free_port(),
                scratch_directory=str(scratch_root),
                boot_timeout_seconds=2,
                launcher_path=str(launcher),
                passt_control_socket=str(temp_path / "passt-control.sock"),
            )
            manager = manager_module.VmManager(config, lambda path, size: path.touch())
            with fake_passt_supervisor(temp_path / "passt-control.sock") as passt_requests:
                with self.assertRaisesRegex(RuntimeError, "status 23"):
                    manager.proxy("POST", "/api/v2/execute", {}, b"{}")
            self.assertEqual(manager.active, 0)
            self.assertEqual(list(scratch_root.iterdir()), [])
            self.assertEqual([request["action"] for request in passt_requests], ["start", "stop"])

    def test_invalid_framing_is_rejected_before_vm_admission(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = manager_module.ManagerConfig(
                bind_host="127.0.0.1",
                bind_port=free_port(),
                max_concurrent_vms=1,
                vm_port_start=free_port(),
                scratch_directory=temp_dir,
            )
            manager = manager_module.VmManager(config, lambda path, size: path.touch())
            server = manager_module.ManagerHttpServer((config.bind_host, config.bind_port), manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection(config.bind_host, config.bind_port, timeout=2)
                connection.putrequest("POST", "/api/v2/execute")
                connection.putheader("Content-Length", "-1")
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
                connection.close()

                connection = HTTPConnection(config.bind_host, config.bind_port, timeout=2)
                connection.request("GET", "/not-an-endpoint")
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
                connection.close()
                self.assertEqual(manager.active, 0)
                self.assertEqual(list(Path(temp_dir).iterdir()), [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()