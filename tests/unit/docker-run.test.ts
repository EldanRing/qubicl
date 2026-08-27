import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { bindMountProbeService, run } from '../../packages/cli/dist/docker.js';

test('command bounds reject invalid combinations before spawning', async () => {
  await assert.rejects(run(process.execPath, [], { timeoutMs: 0 }), /positive number/);
  await assert.rejects(run(process.execPath, [], { maxOutputBytes: 1.5 }), /positive whole number/);
  await assert.rejects(
    run(process.execPath, [], { inherit: true, maxOutputBytes: 1024 }),
    /only be limited when output is captured/,
  );
});

test('captured commands enforce a wall-time limit', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    }),
    /exceeded the 100ms timeout/,
  );
});

test('captured commands enforce a combined output limit', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', "process.stdout.write('x'.repeat(128 * 1024))"], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    }),
    /exceeded the 1024-byte output limit/,
  );
});

test('bind-mount probe uses host identity and preserves retry variables through Compose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-compose-probe-'));
  const composePath = join(root, 'compose.yaml');
  try {
    const service = bindMountProbeService(
      'example.invalid/qubicl-probe:test',
      join(root, 'mount'),
    );
    assert.equal(service.user, `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    assert.deepEqual(service.volumes, [{
      type: 'bind', source: join(root, 'mount'), target: '/probe', read_only: true,
    }]);
    await writeFile(composePath, YAML.stringify({
      services: {
        probe: service,
      },
    }));
    const configured = JSON.parse(await run('docker', [
      'compose', '--file', composePath, 'config', '--format', 'json',
    ])) as { services: { probe: { entrypoint: string[] } } };
    const command = configured.services.probe.entrypoint[2];
    assert.match(command ?? '', /while \[ "\$\$attempt" -lt 20 \]/);
    assert.match(command ?? '', /"\$\$\(cat \/probe\/probe\.txt/);
    assert.match(command ?? '', /attempt=\$\$\(\(attempt \+ 1\)\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
