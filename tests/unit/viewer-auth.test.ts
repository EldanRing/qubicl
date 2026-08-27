import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

test('isolated viewer authentication accepts only the protected key and fails without disclosure', () => {
  const source = join(process.cwd(), 'images/computer/qubicl_viewer_auth.py');
  const script = String.raw`
import importlib.util
import os
import pathlib
import sys
import tempfile
import types

sys.dont_write_bytecode = True

class AuthenticationError(Exception):
    def __init__(self, **details):
        super().__init__(details.get("response_msg"))
        self.details = details

plugins = types.ModuleType("websockify.auth_plugins")
plugins.AuthenticationError = AuthenticationError
package = types.ModuleType("websockify")
package.auth_plugins = plugins
sys.modules["websockify"] = package
sys.modules["websockify.auth_plugins"] = plugins

spec = importlib.util.spec_from_file_location("qubicl_viewer_auth", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
key = "K" * 43
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / "key"
    path.write_text(key + "\n", encoding="ascii")
    os.chmod(path, 0o640)
    auth = module.HeaderKeyAuth(str(path))
    auth.authenticate({"X-Qubicl-Viewer-Key": key}, None, None)
    for received in (None, "bad", "L" * 43):
        try:
            auth.authenticate({"X-Qubicl-Viewer-Key": received}, None, None)
            raise AssertionError("invalid viewer key was accepted")
        except AuthenticationError as error:
            assert error.details["response_code"] == 403
            assert "key" not in error.details["response_msg"].lower()
            assert key not in repr(error.details)
    target = pathlib.Path(directory) / "target"
    target.write_text(key + "\n", encoding="ascii")
    link = pathlib.Path(directory) / "link"
    link.symlink_to(target)
    try:
        module.HeaderKeyAuth(str(link)).authenticate({"X-Qubicl-Viewer-Key": key}, None, None)
        raise AssertionError("symlinked key source was accepted")
    except AuthenticationError as error:
        assert error.details["response_code"] == 503
assert "/opt/qubicl" not in sys.path
`;
  const result = spawnSync('python3', ['-I', '-c', script, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
