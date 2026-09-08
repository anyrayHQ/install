#!/usr/bin/env python3
"""Validate a test-owned LaunchAgent without treating symlink aliases as drift."""
import os
import plistlib
import sys


def verify(path, executable):
    with open(path, 'rb') as stream:
        agent = plistlib.load(stream)
    if not isinstance(agent, dict):
        raise ValueError('LaunchAgent must be a dictionary')
    if agent.get('Label') != 'ai.anyray.connect-tray':
        raise ValueError('LaunchAgent label does not match the desktop app')
    if agent.get('RunAtLoad') is not True:
        raise ValueError('LaunchAgent must run at login')
    arguments = agent.get('ProgramArguments')
    if not isinstance(arguments, list) or len(arguments) != 1 or not isinstance(arguments[0], str):
        raise ValueError('LaunchAgent must contain only the installed executable argument')
    if not os.path.isabs(arguments[0]) or not os.path.samefile(arguments[0], executable):
        raise ValueError('LaunchAgent executable does not resolve to the installed desktop app')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: verify-desktop-launchagent.py <plist> <installed-executable>')
        verify(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(f'::error::Desktop LaunchAgent verification failed: {error}', file=sys.stderr)
        sys.exit(1)
    print('Desktop LaunchAgent label, login setting, and installed executable verified')
