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
from unittest import mock
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
            request = json.loads(self.rfile.readline())
            requests.append(request)
            self.wfile.write(b'{"ok":false,"error":"vm_id is required"}\n' if request == {} else b'{"ok":true}\n')

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
    def test_supervisor_mode_is_explicit_and_validated(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(manager_module.ManagerConfig.from_env().passt_supervisor_mode, "managed")
        with mock.patch.dict(os.environ, {"SANDBOX_VM_PASST_SUPERVISOR_MODE": "external"}, clear=True):
            self.assertEqual(manager_module.ManagerConfig.from_env().passt_supervisor_mode, "external")
        for mode in ("", "auto", "External", " managed"):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(ValueError, "must be managed or external"):
                    manager_module.ManagerConfig(passt_supervisor_mode=mode)
                with mock.patch.dict(os.environ, {"SANDBOX_VM_PASST_SUPERVISOR_MODE": mode}, clear=True):
                    with self.assertRaisesRegex(ValueError, "must be managed or external"):
                        manager_module.ManagerConfig.from_env()

    def test_external_supervisor_survives_manager_normal_and_exceptional_shutdown(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            control = Path(temp_dir) / "control.sock"
            config = manager_module.ManagerConfig(
                passt_supervisor_mode="external", passt_control_socket=str(control),
                passt_supervisor_path="/must/not/be/executed", scratch_directory=str(Path(temp_dir) / "scratch"),
                boot_timeout_seconds=1,
            )
            with fake_passt_supervisor(control) as requests:
                inode = control.stat().st_ino
                manager = manager_module.VmManager(config, lambda p, s: p.touch())
                with mock.patch.object(manager_module.subprocess, "Popen", side_effect=AssertionError("external spawn")), \
                     mock.patch.object(manager_module.os, "killpg", side_effect=AssertionError("external kill")), \
                     mock.patch.object(Path, "unlink", side_effect=AssertionError("external unlink")):
                    for fails in (False, True):
                        try:
                            with manager_module.running_passt_supervisor(config) as owned:
                                self.assertIsNone(owned)
                                manager._control_passt("start", "vm-1234abcd", 21000)
                                manager._control_passt("stop", "vm-1234abcd")
                                manager.close()
                                if fails:
                                    raise RuntimeError("manager fixture failure")
                        except RuntimeError as error:
                            self.assertTrue(fails)
                            self.assertEqual(str(error), "manager fixture failure")
                        self.assertEqual(control.stat().st_ino, inode)
                        manager_module.wait_for_external_passt_supervisor(config)
                self.assertEqual([r["action"] for r in requests if r], ["start", "stop", "start", "stop"])
                self.assertTrue(all(r.get("vm_id") == "vm-1234abcd" for r in requests if r))
                self.assertEqual(sum(r == {} for r in requests), 4)

    def test_external_readiness_waits_for_late_sidecar(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            control = Path(temp_dir) / "control.sock"
            config = manager_module.ManagerConfig(passt_supervisor_mode="external", passt_control_socket=str(control), boot_timeout_seconds=1)
            ready = threading.Event()
            errors = []

            def wait():
                try:
                    with manager_module.running_passt_supervisor(config):
                        ready.set()
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=wait)
            thread.start()
            try:
                self.assertFalse(ready.wait(0.05))
                with fake_passt_supervisor(control):
                    self.assertTrue(ready.wait(2))
            finally:
                thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])

    def test_external_missing_and_stale_socket_timeout_without_unlink(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            control = Path(temp_dir) / "control.sock"
            config = manager_module.ManagerConfig(passt_supervisor_mode="external", passt_control_socket=str(control), boot_timeout_seconds=0.1)
            for stale in (False, True):
                if stale:
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.bind(str(control))
                    inode = control.stat().st_ino
                started = time.monotonic()
                with self.assertRaisesRegex(TimeoutError, "external passt supervisor did not become ready"):
                    with manager_module.running_passt_supervisor(config):
                        self.fail("must not proceed without readiness")
                self.assertLess(time.monotonic() - started, 1)
                if stale:
                    self.assertEqual(control.stat().st_ino, inode)
                else:
                    self.assertFalse(control.exists())

    def test_external_readiness_rejects_bad_protocol_and_bounds_silent_peer(self):
        for payload in (b'not-json\n', b'{"ok":true}\n', b'x' * 4097 + b'\n', b'', None):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as temp_dir:
                control = Path(temp_dir) / "control.sock"
                release = threading.Event()

                class Handler(socketserver.StreamRequestHandler):
                    def handle(self):
                        self.rfile.readline()
                        if payload is None:
                            release.wait(1)
                        else:
                            self.wfile.write(payload)

                server = socketserver.ThreadingUnixStreamServer(str(control), Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                config = manager_module.ManagerConfig(passt_supervisor_mode="external", passt_control_socket=str(control), boot_timeout_seconds=0.1)
                started = time.monotonic()
                try:
                    with self.assertRaises((RuntimeError, TimeoutError)) as raised:
                        with manager_module.running_passt_supervisor(config):
                            self.fail("must reject peer")
                    self.assertIn("external passt", str(raised.exception))
                    self.assertLess(time.monotonic() - started, 1)
                    self.assertTrue(control.is_socket())
                finally:
                    release.set()
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_external_permission_error_is_explicit(self):
        config = manager_module.ManagerConfig(passt_supervisor_mode="external")
        with mock.patch.object(manager_module.socket.socket, "connect", side_effect=PermissionError("fixture denied")):
            with self.assertRaisesRegex(RuntimeError, "cannot connect to external passt supervisor.*fixture denied"):
                with manager_module.running_passt_supervisor(config):
                    self.fail("must not proceed")

    def test_overlay_preserves_private_upstream_dns_mount(self):
        overlay = (ROOT / "docker" / "full-debian-overlay.sh").read_text()
        self.assertIn("mount -o remount,rw,nosuid,nodev,size=128m /run", overlay)
        self.assertNotIn("tmpfs /run", overlay)

    def test_passt_supervisor_is_started_and_reaped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "supervisor.py"
            script.write_text(f'''#!{sys.executable}
import os, socket, time
s = socket.socket(socket.AF_UNIX)
s.bind(os.environ['PASST_SOCKET_ROOT'] + '/control.sock')
s.listen()
time.sleep(30)
''')
            script.chmod(0o755)
            config = manager_module.ManagerConfig(
                passt_supervisor_path=str(script),
                passt_control_socket=str(Path(temp_dir) / "control.sock"),
                boot_timeout_seconds=2, shutdown_timeout_seconds=1,
            )
            with manager_module.running_passt_supervisor(config) as process:
                self.assertIsNone(process.poll())
            self.assertIsNotNone(process.poll())

    def test_passt_startup_failure_is_not_hidden(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = manager_module.ManagerConfig(
                passt_supervisor_path="/bin/false",
                passt_control_socket=str(Path(temp_dir) / "control.sock"),
                boot_timeout_seconds=1,
            )
            with self.assertRaisesRegex(RuntimeError, "before readiness"):
                with manager_module.running_passt_supervisor(config):
                    self.fail("must not admit jobs without passt")

    def test_closed_manager_rejects_new_jobs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = manager_module.VmManager(
                manager_module.ManagerConfig(scratch_directory=temp_dir), lambda p, s: p.touch()
            )
            manager.close()
            with self.assertRaises(manager_module.VmCapacityError):
                manager.proxy("POST", "/api/v2/execute", {}, b"{}")
            self.assertEqual(manager.active, 0)

    def test_teardown_kills_group_even_when_launcher_already_exited(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = manager_module.VmManager(
                manager_module.ManagerConfig(scratch_directory=temp_dir), lambda p, s: p.touch()
            )
            process = mock.Mock(pid=12345)
            process.poll.return_value = 0
            with mock.patch.object(manager_module.os, "killpg") as killpg:
                manager._stop_vm(process)
            self.assertEqual(killpg.call_args_list[-1].args, (12345, manager_module.signal.SIGKILL))
            process.wait.assert_called()

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
        self.check_request_lifecycle("managed")

    def test_external_supervisor_keeps_serving_after_real_request_lifecycle(self):
        self.check_request_lifecycle("external")

    def check_request_lifecycle(self, mode):
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
            'manifest_required': os.environ.get('SANDBOX_REQUIRE_EGRESS_MANIFEST'),
            'session_disabled': os.environ.get('SANDBOX_SESSION_WORKSPACE_ENABLED'),
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
                passt_supervisor_mode=mode,
            )

            def fake_disk_builder(path: Path, size_mib: int) -> None:
                self.assertEqual(size_mib, 32)
                path.write_bytes(b"ext4-placeholder")

            manager = manager_module.VmManager(config, fake_disk_builder)
            with fake_passt_supervisor(temp_path / "passt-control.sock") as passt_requests:
                lifecycle = manager_module.running_passt_supervisor(config) if mode == "external" else contextlib.nullcontext()
                with lifecycle:
                    try:
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
                    finally:
                        manager.close()
                if mode == "external":
                    manager_module.wait_for_external_passt_supervisor(config)
                passt_requests = [request for request in passt_requests if request]

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
                    "manifest_required": "true",
                    "session_disabled": "false",
                },
            )
            self.assertEqual(manager.active, 0)
            self.assertEqual(list(scratch_root.iterdir()), [])
            self.assertEqual([request["action"] for request in passt_requests], ["start", "stop"])
            self.assertEqual(passt_requests[0]["host_port"], config.vm_port_start)
            self.assertEqual(passt_requests[0]["guest_port"], 2000)
            self.assertEqual(passt_requests[0]["vm_id"], passt_requests[1]["vm_id"])

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
