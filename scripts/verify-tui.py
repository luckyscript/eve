#!/usr/bin/env python3
"""Exercise the actual readline TUI in a PTY; no model requests or config writes."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ['NO_COLOR'] = '1'
    os.execvp('node', ['node', 'bin/eve.mjs', 'tui'])

buffer = ''
checks = {}
finished = False

def expect(text, timeout=10):
    global buffer
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if text in buffer:
            buffer = ''
            return True
        ready, _, _ = select.select([fd], [], [], min(0.2, max(0, deadline - time.monotonic())))
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            buffer += data.decode('utf-8', errors='replace')
    return False

def command(text, expected):
    os.write(fd, (text + '\n').encode())
    return expect(expected)

try:
    checks['startsInRealTTY'] = expect('eve ›')
    checks['helpCommand'] = command('/help', '工具仅限 workspace')
    checks['skillsCommand'] = command('/skills', 'workspace-report')
    checks['redactedConfigCommand'] = command('/config', 'apiKey')
    checks['newConversationCommand'] = command('/new', '已开始新会话')
    os.write(fd, b'/exit\n')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found, status = os.waitpid(pid, os.WNOHANG)
        if found:
            finished = True
            checks['cleanExit'] = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
            break
        select.select([fd], [], [], 0.1)
        try:
            if select.select([fd], [], [], 0)[0]:
                os.read(fd, 65536)
        except OSError:
            pass
    checks.setdefault('cleanExit', False)
    passed = all(checks.values())
    print(json.dumps({'passed': passed, 'checks': checks}, ensure_ascii=False, indent=2))
    sys.exit(0 if passed else 1)
finally:
    if not finished:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(fd)
