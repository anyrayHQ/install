"""Safety regressions; never invoke macOS registration or touch a real profile."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'desktop_smoke', Path(__file__).with_name('smoke-connect-desktop-macos.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class AccountBoundaryTest(unittest.TestCase):
    def test_root_is_rejected_before_any_native_command_or_profile_write(self):
        with tempfile.TemporaryDirectory() as directory:
            account = SimpleNamespace(pw_dir=directory, pw_name='synthetic-user')
            with patch.object(smoke.sys, 'argv', ['smoke', directory]), \
                    patch.object(smoke.os, 'getuid', return_value=0), \
                    patch.object(smoke.pwd, 'getpwuid', return_value=account), \
                    patch.object(smoke, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'GUI login session'):
                    smoke.main()
                run.assert_not_called()
                self.assertFalse((Path(directory) / '.anyray').exists())

    def test_redirected_home_is_rejected_before_any_native_command(self):
        with tempfile.TemporaryDirectory() as directory:
            account = SimpleNamespace(pw_dir=directory, pw_name='synthetic-user')
            original_stat = smoke.os.stat

            def stat(path, *args, **kwargs):
                if str(path) == '/dev/console':
                    return SimpleNamespace(st_uid=501)
                return original_stat(path, *args, **kwargs)

            with patch.object(smoke.sys, 'argv', ['smoke', directory]), \
                    patch.object(smoke.os, 'getuid', return_value=501), \
                    patch.object(smoke.os, 'stat', side_effect=stat), \
                    patch.object(smoke.pwd, 'getpwuid', return_value=account), \
                    patch.object(smoke.Path, 'home', return_value=Path(directory) / 'redirected'), \
                    patch.object(smoke, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'redirected HOME'):
                    smoke.main()
                run.assert_not_called()
                self.assertFalse((Path(directory) / '.anyray').exists())


class RestartBoundaryTest(unittest.TestCase):
    def test_registration_alone_does_not_prove_restart(self):
        with patch.object(smoke.time, 'monotonic', side_effect=[0, 0, 31]), \
                patch.object(smoke.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'restart'):
                smoke.wait_for_restart(lambda: [], 101)

    def test_restart_requires_the_launched_tray_and_engine(self):
        with patch.object(smoke.time, 'monotonic', return_value=0):
            smoke.wait_for_restart(lambda: [101, 102], 101)


if __name__ == '__main__':
    unittest.main()
