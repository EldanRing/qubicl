"""Both supported launchers must deliver RFB as the separate viewer user.

Run as root in a disposable guest with Xvfb owned by qubicl and DISPLAY set.
No TCP listener, gateway, installed launcher or user desktop is changed.
"""
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile

source = Path(__file__).resolve().parents[2] / 'images/computer/x11vnc-relay.sh'
with tempfile.TemporaryDirectory(prefix='qubicl-viewer-fixture-') as directory:
    os.chmod(directory, 0o755)
    for mode in ('view', 'control'):
        launcher = Path(directory) / ('qubicl-x11vnc-' + mode)
        launcher.write_bytes(source.read_bytes())
        launcher.chmod(0o755)
        client, server = socket.socketpair()
        client.settimeout(6)
        process = subprocess.Popen(['runuser', '-u', 'qubicl-viewer', '--', 'env',
                                    'DISPLAY=' + os.environ['DISPLAY'], str(launcher)],
                                   stdin=server, stdout=server, stderr=subprocess.PIPE)
        server.close()

        def read(count):
            result = b''
            while len(result) < count:
                part = client.recv(count - len(result))
                assert part, 'RFB stream ended: ' + process.stderr.read().decode('utf-8', 'replace')[-2000:]
                result += part
            return result

        try:
            assert read(12) == b'RFB 003.008\n'
            client.sendall(b'RFB 003.008\n')
            count = read(1)[0]
            assert 1 in read(count), 'Unix relay uses no in-band password; gateway owns authentication'
            client.sendall(b'\x01')
            assert read(4) == b'\0\0\0\0'
            client.sendall(b'\x01')
            header = read(24)
            width, height = struct.unpack('>HH', header[:4])
            bits_per_pixel = header[4]
            name_length = struct.unpack('>I', header[20:])[0]
            assert name_length < 4096
            read(name_length)
            assert width > 0 and height > 0
            client.sendall(struct.pack('>BBHi', 2, 0, 1, 0))  # Request raw pixels.
            client.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, 64, 64))
            message, _, rectangles = struct.unpack('>BBH', read(4))
            assert message == 0 and rectangles > 0
            for _ in range(rectangles):
                x, y, w, h, encoding = struct.unpack('>HHHHi', read(12))
                assert encoding == 0 and w * h <= width * height
                read(w * h * bits_per_pixel // 8)
            print(f'PASS: {mode} relay delivers RFB handshake and pixels as qubicl-viewer')
        finally:
            client.close()
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
