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


class AdoptedProfileTest(unittest.TestCase):
    def adopted(self, directory):
        app = Path(directory) / 'Anyray Connect.app'
        (app / 'Contents/MacOS').mkdir(parents=True)
        (app / 'Contents/MacOS/anyray-connect').write_bytes(b'synthetic engine')
        profile = dict(smoke.EXISTING_PROFILE, engineOwner='app', persistenceOwner='tray',
                       loginRegistrationState='enabled', trayAppPath=str(app),
                       engineOwnerPath=str(app / 'Contents/MacOS/anyray-connect'),
                       engineOwnerObservedAt='2026-09-08T11:10:50.343Z',
                       loginRegistrationObservedAt='2026-09-08T11:10:50.3435678Z')
        return app, profile

    def test_accepts_adoption_that_records_the_installed_app(self):
        with tempfile.TemporaryDirectory() as directory:
            app, profile = self.adopted(directory)
            smoke.check_adopted_profile(profile, app, 'enabled')

    def test_rejects_drift_from_the_installed_app(self):
        with tempfile.TemporaryDirectory() as directory:
            app, profile = self.adopted(directory)
            for field, value, message in (
                ('name', 'changed', 'existing profile field'),
                ('managedEnrollmentDisabled', False, 'existing profile field'),
                ('persistenceOwner', 'durable', 'adopted ownership'),
                ('loginRegistrationState', 'disabled', 'login registration'),
                ('trayAppPath', directory, 'installed app'),
                ('trayAppPath', 'Anyray Connect.app', 'absolute'),
                ('engineOwnerPath', str(app), 'installed app'),
                ('engineOwnerObservedAt', '2026-09-08T11:10:50.343+00:00', 'RFC 3339'),
                ('loginRegistrationObservedAt', '2026-13-08T11:10:50Z', 'RFC 3339'),
                ('loginRegistrationObservedAt', None, 'RFC 3339'),
            ):
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, message):
                    smoke.check_adopted_profile(dict(profile, **{field: value}), app, 'enabled')


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
