#!/usr/bin/python3
"""Small JSON-lines PTY bridge for Qubicl's isolated executor runner."""

import base64
import ctypes
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def window_size(master, rows, columns):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def terminate(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("PTY input made no progress")
        view = view[written:]


def handle_request(line, master, pid):
    request = json.loads(line)
    action = request.get("type")
    if action == "input":
        write_all(master, base64.b64decode(request["data"], validate=True))
        return False
    if action == "resize":
        window_size(master, int(request["rows"]), int(request["columns"]))
        terminate(pid, signal.SIGWINCH)
        return False
    if action == "signal":
        terminate(pid, getattr(signal, request["signal"]))
        return False
    if action == "close":
        terminate(pid, signal.SIGHUP)
        return True
    raise ValueError("unknown PTY action")


def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: pty-helper.py ROWS COLUMNS CWD COMMAND")
    rows, columns = int(sys.argv[1]), int(sys.argv[2])
    cwd, command = sys.argv[3], sys.argv[4]
    pid, master = os.forkpty()
    if pid == 0:
        os.chdir(cwd)
        ctypes.CDLL(None).prctl(1, signal.SIGKILL)
        os.execv("/bin/bash", ["bash", "-lc", command])
    window_size(master, rows, columns)
    emit({"type": "ready", "pid": pid})
    closing = False
    stdin_fd = sys.stdin.fileno()
    stdin_open = True
    input_buffer = bytearray()
    while True:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            if os.WIFEXITED(status):
                emit({"type": "exit", "code": os.WEXITSTATUS(status)})
            else:
                emit({"type": "exit", "signal": signal.Signals(os.WTERMSIG(status)).name})
            break
        inputs = [master]
        if stdin_open:
            inputs.append(stdin_fd)
        readable, _, _ = select.select(inputs, [], [], 0.2)
        if master in readable:
            try:
                data = os.read(master, 16384)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data:
                emit({"type": "output", "data": base64.b64encode(data).decode("ascii")})
        if stdin_open and stdin_fd in readable:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                terminate(pid, signal.SIGHUP)
                closing = True
                stdin_open = False
            else:
                input_buffer.extend(chunk)
                while b"\n" in input_buffer:
                    line, _, remainder = input_buffer.partition(b"\n")
                    input_buffer = bytearray(remainder)
                    if len(line) > 262144:
                        emit({"type": "error", "message": "oversized PTY action"})
                        terminate(pid, signal.SIGHUP)
                        closing = True
                        stdin_open = False
                        input_buffer.clear()
                        break
                    try:
                        closing = handle_request(line, master, pid) or closing
                    except Exception as error:  # protocol failures are returned, never interpreted as shell input
                        emit({"type": "error", "message": str(error)[:500]})
                if len(input_buffer) > 262144:
                    emit({"type": "error", "message": "oversized PTY action"})
                    terminate(pid, signal.SIGHUP)
                    closing = True
                    stdin_open = False
                    input_buffer.clear()
        if closing:
            # The normal wait loop confirms the shell is gone. A bounded hard
            # stop is owned by the Node manager if the shell ignores SIGHUP.
            continue
    os.close(master)


if __name__ == "__main__":
    main()
