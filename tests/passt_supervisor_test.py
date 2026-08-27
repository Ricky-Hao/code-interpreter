#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "docker" / "passt-supervisor.py"
SPEC = importlib.util.spec_from_file_location("passt_supervisor", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
passt_supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(passt_supervisor)


class PasstSupervisorTest(unittest.TestCase):
    def test_rejects_invalid_vm_ids_and_ports(self):
        for vm_id in ["vm-123", "../vm-12345678", "vm-1234567_", "vm-123456789"]:
            with self.assertRaisesRegex(ValueError, "invalid VM ID"):
                passt_supervisor.PasstSupervisor._validate(vm_id, 21000, 2000)
        for port in [0, 65536]:
            with self.assertRaisesRegex(ValueError, "invalid port"):
                passt_supervisor.PasstSupervisor._validate("vm-1234abcd", port, 2000)

    def test_start_uses_expected_passt_arguments(self):
        supervisor = passt_supervisor.PasstSupervisor()
        process = mock.Mock()
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as temp_dir:
            socket_path = Path(temp_dir) / "vm-1234abcd.sock"
            with (
                mock.patch.object(passt_supervisor, "SOCKET_ROOT", Path(temp_dir)),
                mock.patch.object(passt_supervisor.subprocess, "Popen", return_value=process) as popen,
                mock.patch.object(Path, "exists", return_value=True),
                mock.patch.object(supervisor, "_ipv4_listener_exists", return_value=True),
                mock.patch.object(passt_supervisor.threading, "Thread") as thread,
            ):
                supervisor.start("vm-1234abcd", 21017, 2000)

        popen.assert_called_once_with(
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
                "21017:2000",
            ],
            stdin=passt_supervisor.subprocess.DEVNULL,
        )
        thread.assert_called_once()
        thread.return_value.start.assert_called_once_with()

    def test_ipv4_listener_detection_ignores_ipv6_only_socket(self):
        tcp_table = """  sl  local_address rem_address   st
   0: 00000000:55EF 00000000:0000 0A
"""
        with mock.patch.object(Path, "read_text", return_value=tcp_table):
            self.assertTrue(passt_supervisor.PasstSupervisor._ipv4_listener_exists(21999))
            self.assertFalse(passt_supervisor.PasstSupervisor._ipv4_listener_exists(22000))


if __name__ == "__main__":
    unittest.main()