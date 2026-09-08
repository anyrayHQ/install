#!/usr/bin/env python3
"""Signed native lifecycle smoke. Run only in a dedicated, logged-in test account."""
from datetime import datetime
import hashlib
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
EXISTING_PROFILE = {
    'name': 'existing-cli-sentinel',
    'managedEnrollmentDisabled': True,
    'refreshSchedulerEnabled': False,
}


def rfc3339_utc(value):
    # Same shape verify-desktop-profile.mjs accepts: seconds plus 1 to 9 fractional digits.
    match = isinstance(value, str) and re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z', value)
    if not match:
        return False
    try:
        datetime.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return False
    return True


def check_adopted_profile(profile, app, expected_login):
    """Every existing field survives; adoption records the installed app and valid timestamps."""
    for key, value in EXISTING_PROFILE.items():
        if profile.get(key) != value:
            raise RuntimeError(f'lost existing profile field {key}')
    if profile.get('engineOwner') != 'app' or profile.get('persistenceOwner') != 'tray':
        raise RuntimeError('installed app has not adopted ownership')
    if profile.get('loginRegistrationState') != expected_login:
        raise RuntimeError('unexpected recorded login registration state')
    engine = app / 'Contents/MacOS/anyray-connect'
    for key, installed in (('trayAppPath', app), ('engineOwnerPath', engine)):
        recorded = profile.get(key)
        if not isinstance(recorded, str) or not os.path.isabs(recorded):
            raise RuntimeError(f'{key} is not an absolute path')
        if Path(recorded).resolve() != installed.resolve():
            raise RuntimeError(f'{key} does not resolve to the installed app')
    for key in ('engineOwnerObservedAt', 'loginRegistrationObservedAt'):
        if not rfc3339_utc(profile.get(key)):
            raise RuntimeError(f'{key} is not an RFC 3339 UTC timestamp')


def run(args, check=True):
    return subprocess.run(args, check=check, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, timeout=30)


def wait_for_restart(processes, tray_pid, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        running = processes()
        if tray_pid in running and len(running) == 2:
            return
        time.sleep(0.25)
    raise RuntimeError('restart did not produce the tray and resident engine')


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
    if (info['CFBundleIdentifier'] != LABEL or info['LSMinimumSystemVersion'] != '13.0'
            or info.get('CFBundleName') != 'Anyray Connect'
            or info.get('CFBundleDisplayName', 'Anyray Connect') != 'Anyray Connect'):
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
    foreign_agent = home / 'Library/LaunchAgents/ai.anyray.connect.refresh-sentinel.plist'

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
            or scheduler.exists() or foreign_agent.exists() or processes()):
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
    try:
        legacy.parent.mkdir(parents=True, exist_ok=True)
        # A foreign LaunchAgent beside connect's own (which a correct adopt may remove): nothing may touch it.
        foreign_agent.write_bytes(b'<plist><dict><key>Label</key><string>existing-scheduler-sentinel</string></dict></plist>\n')
        foreign_before = hashlib.sha256(foreign_agent.read_bytes()).hexdigest()
        for scenario in ('fresh', 'legacy-enabled', 'legacy-disabled'):
            state = state_dir / 'connect.json'
            state.write_text(json.dumps(EXISTING_PROFILE))
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
            check_adopted_profile(profile, app, expected)
            stop()
            # Process exit must retain registration; restarting must preserve consent.
            if native() != observed:
                raise RuntimeError(f'{scenario}: process exit changed native registration')
            restarted = subprocess.Popen([str(binary)], stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
            wait_for_restart(processes, restarted.pid)
            if native() != observed:
                raise RuntimeError(f'{scenario}: restart changed native registration')
            stop()
            if native('unregister') != 'not-registered':
                raise RuntimeError(f'{scenario}: native unregister failed')
            if hashlib.sha256(foreign_agent.read_bytes()).hexdigest() != foreign_before:
                raise RuntimeError(f'{scenario}: changed a LaunchAgent it does not own')
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
            lambda: foreign_agent.unlink(missing_ok=True),
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
