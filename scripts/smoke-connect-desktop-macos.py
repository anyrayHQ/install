#!/usr/bin/env python3
"""Signed native lifecycle smoke. Run only in a dedicated, logged-in test account."""
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import signal
import subprocess
import sys
import time

LABEL = 'ai.anyray.connect-tray'


def run(args, check=True):
    return subprocess.run(args, check=check, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, timeout=30)


def main():
    app = Path(sys.argv[1]).resolve(strict=True)
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    if os.getuid() == 0 or os.stat('/dev/console').st_uid != os.getuid():
        raise RuntimeError('dedicated test account must own the GUI login session')
    if Path.home() != home:
        raise RuntimeError('redirected HOME does not isolate native login items')
    with (app / 'Contents/Info.plist').open('rb') as source:
        info = plistlib.load(source)
    if info['CFBundleIdentifier'] != LABEL or info['LSMinimumSystemVersion'] != '13.0':
        raise RuntimeError('unexpected desktop identity or macOS floor')
    binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
    engine = app / 'Contents/MacOS/anyray-connect'
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'

    def missing_job(service):
        code = run(['/bin/launchctl', 'print', service], check=False).returncode
        if code not in (0, 113):
            raise RuntimeError('launchd job inspection unavailable')
        return code == 113
    state_dir = home / '.anyray'
    legacy = home / 'Library/LaunchAgents' / f'{LABEL}.plist'
    scheduler = home / 'Library/LaunchAgents/ai.anyray.connect.refresh.plist'

    def native(action='status'):
        result = run([str(binary), 'login-item', action, '--json'])
        return json.loads(result.stdout)['status']

    def processes():
        output = run(['/bin/ps', '-U', account.pw_name, '-o', 'pid=,comm=']).stdout
        result = []
        for line in output.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[1] in (str(binary), str(engine)):
                result.append(int(fields[0]))
        return result

    def stop():
        for pid in processes():
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for _ in range(20):
            if not processes():
                return
            time.sleep(0.25)
        for pid in processes():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    if (state_dir.exists() or legacy.exists() or Path(str(legacy) + '.retiring').exists()
            or scheduler.exists() or processes()):
        raise RuntimeError('test account already contains Anyray state')
    if not missing_job(target):
        raise RuntimeError('test account already contains the legacy login job')
    disabled = run(['/bin/launchctl', 'print-disabled', domain]).stdout
    if re.search(r'"ai\.anyray\.connect-tray"\s*=>\s*true', disabled):
        raise RuntimeError('test account already contains legacy login consent')
    if native() != 'not-registered':
        raise RuntimeError('test account already contains a native login registration')

    # This directory is exclusively created by this smoke; cleanup never removes prior state.
    state_dir.mkdir(mode=0o700)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    try:
        for scenario in ('fresh', 'legacy-enabled', 'legacy-disabled'):
            state = state_dir / 'connect.json'
            state.write_text(json.dumps({
                'managedEnrollmentDisabled': True,
                'refreshSchedulerEnabled': False,
            }))
            state.chmod(0o600)
            if scenario != 'fresh':
                with legacy.open('wb') as output:
                    plistlib.dump({'Label': LABEL, 'ProgramArguments': [str(binary)],
                                   'RunAtLoad': True}, output)
                if scenario == 'legacy-disabled':
                    run(['/bin/launchctl', 'disable', target])
                else:
                    run(['/bin/launchctl', 'bootstrap', domain, str(legacy)])
            if scenario != 'legacy-enabled':
                subprocess.Popen([str(binary)], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
            expected = 'disabled' if scenario == 'legacy-disabled' else 'enabled'
            deadline = time.monotonic() + 120
            passed = False
            while time.monotonic() < deadline:
                try:
                    profile = json.loads(state.read_text())
                except (OSError, ValueError):
                    profile = {}
                if (profile.get('engineOwner') == 'app'
                        and profile.get('persistenceOwner') == 'tray'
                        and profile.get('loginRegistrationState') == expected
                        and not legacy.exists()
                        and not Path(str(legacy) + '.retiring').exists()
                        and missing_job(target)
                        and len(processes()) == 2):
                    passed = True
                    break
                time.sleep(2)
            if not passed:
                raise RuntimeError(f'{scenario}: native migration did not converge')
            observed = native()
            if observed != ('not-registered' if expected == 'disabled' else 'enabled'):
                raise RuntimeError(f'{scenario}: unexpected native login state')
            if scheduler.exists():
                raise RuntimeError(f'{scenario}: created a refresh scheduler')
            if profile.get('managedEnrollmentDisabled') is not True:
                raise RuntimeError(f'{scenario}: lost enrollment opt-out')
            stop()
            # Quit must retain registration; restarting must preserve observed consent.
            if native() != observed:
                raise RuntimeError(f'{scenario}: Quit changed native registration')
            subprocess.Popen([str(binary)], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            time.sleep(5)
            if native() != observed:
                raise RuntimeError(f'{scenario}: restart changed native registration')
            stop()
            if native('unregister') != 'not-registered':
                raise RuntimeError(f'{scenario}: native unregister failed')
            print(json.dumps({'scenario': scenario, 'result': 'passed'}), flush=True)
    finally:
        cleanup_failed = False
        # Attempt every owned cleanup even if one OS operation fails.
        for cleanup in (
            lambda: run(['/bin/launchctl', 'bootout', target], check=False),
            stop,
            lambda: native('unregister'),
            lambda: run(['/bin/launchctl', 'enable', target]),
            lambda: legacy.unlink(missing_ok=True),
            lambda: Path(str(legacy) + '.retiring').unlink(missing_ok=True),
            lambda: shutil.rmtree(state_dir),
        ):
            try:
                cleanup()
            except Exception:
                cleanup_failed = True
        if cleanup_failed:
            print('::error::native smoke cleanup failed; reset the dedicated account', file=sys.stderr)
            if sys.exc_info()[0] is None:
                raise RuntimeError('native smoke cleanup failed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No raw process or profile output in CI logs.
        print('::error::signed macOS native lifecycle smoke failed', file=sys.stderr)
        sys.exit(1)
