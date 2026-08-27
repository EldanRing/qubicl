import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCleanupPlan,
  executeCleanupPlan,
  type CleanupImage,
  type CleanupInventoryItem,
  type CleanupSelection,
  type CleanupSnapshot,
} from '../../packages/cli/dist/cleanup-plan.js';
import {
  assertCleanupSucceeded,
  assertExactInspectionIdentitySet,
  parseIdentifierLines,
} from '../../packages/cli/dist/cleanup-command.js';

test('cleanup preview selects only verified unreferenced Qubicl-owned resources and records', () => {
  const snapshot = cleanupSnapshot();
  const plan = buildCleanupPlan(snapshot, allSelection());

  assert.deepEqual(plan.candidates.map(({ kind, name }) => `${kind}:${name}`), [
    'container:qubicl-old-computer',
    'network:qubicl-old-control',
    'cache-record:old-contract',
    'evidence-record:old-acquisition',
  ]);
  assert.equal(plan.candidates.every(({ validationDigest }) => /^[a-f0-9]{64}$/.test(validationDigest)), true);
  assert.equal(plan.reviewDigest, buildCleanupPlan(snapshot, allSelection()).reviewDigest);

  const reasons = new Map(plan.preserved.map((item) => [item.name, item.reason]));
  assert.equal(reasons.get('qubicl-current-computer'), 'current-managed-runtime');
  assert.equal(reasons.get('qubicl-running-orphan'), 'running-resource');
  assert.equal(reasons.get('unrelated-container'), 'ownership-unverified');
  assert.equal(reasons.get('qubicl-attached-control'), 'running-resource');
  assert.equal(reasons.get('qubicl-home'), 'durable-home');
  assert.equal(reasons.get('qubicl-old-x11'), 'mutable-identity');
  assert.equal(reasons.get('unrelated-volume'), 'ownership-unverified');
  assert.equal(reasons.get('current-qubicl-image'), 'current-or-retained-image');
  assert.equal(reasons.get('retained-qubicl-image'), 'current-or-retained-image');
  assert.equal(reasons.get('running-image'), 'running-resource');
  assert.equal(reasons.get('stopped-image'), 'container-referenced-image');
  assert.equal(reasons.get('stale-qubicl-image'), 'shared-global-image');
  assert.equal(reasons.get('forged-label-image'), 'shared-global-image');
  assert.equal(reasons.get('global-dangling-image'), 'ownership-unverified');
  assert.equal(reasons.get('current-contract'), 'record-referenced');
  assert.equal(reasons.get('unknown-record-version'), 'ownership-unverified');
});

test('cleanup selection is explicit and never broadens into unselected resource classes', () => {
  const plan = buildCleanupPlan(cleanupSnapshot(), { orphans: true, images: false, records: false });
  assert.equal(plan.candidates.every(({ kind }) => ['container', 'network', 'volume'].includes(kind)), true);
  assert.equal(plan.preserved.find(({ name }) => name === 'stale-qubicl-image')?.reason, 'not-selected');
  assert.equal(plan.preserved.find(({ name }) => name === 'old-contract')?.reason, 'not-selected');
});

test('cleanup execution refuses a changed initial inventory before deleting anything', async () => {
  const snapshot = cleanupSnapshot();
  const reviewed = buildCleanupPlan(snapshot, allSelection());
  const changed = cloneSnapshot(snapshot);
  const candidate = changed.items.find((item) => item.kind === 'container' && item.name === 'qubicl-old-computer');
  assert.ok(candidate?.kind === 'container');
  candidate.status = 'running';
  let removals = 0;

  await assert.rejects(executeCleanupPlan(reviewed, {
    replan: async () => buildCleanupPlan(changed, allSelection()),
    remove: async () => { removals += 1; },
  }), /inventory changed after preview/);
  assert.equal(removals, 0);
});

test('cleanup revalidates each reviewed candidate and precisely reports preservation and failures', async () => {
  const snapshot: CleanupSnapshot = {
    installationId: INSTALLATION,
    projectName: 'qubicl',
    expectedContainers: new Set(),
    expectedNetworks: new Set(),
    expectedVolumes: new Set(),
    protectedImageReferences: new Set(),
    retainedManagedImageReferences: new Set(),
    items: [
      container('one', 'qubicl-one', 'exited'),
      container('three', 'qubicl-three', 'exited'),
      network('two', 'qubicl-two-control'),
    ],
  };
  const reviewed = buildCleanupPlan(snapshot, allSelection());
  const removed: string[] = [];
  let replans = 0;

  const result = await executeCleanupPlan(reviewed, {
    replan: async () => {
      replans += 1;
      if (replans === 4) {
        const changing = snapshot.items.find((item) => item.kind === 'network');
        assert.ok(changing?.kind === 'network');
        changing.attachedContainers = [{ containerId: 'now-running', running: true }];
      }
      return buildCleanupPlan(snapshot, allSelection());
    },
    remove: async (candidate) => {
      if (candidate.name === 'qubicl-three') throw new Error('Docker preserved the reviewed container');
      removed.push(candidate.name);
      snapshot.items = snapshot.items.filter((item) => !(item.kind === candidate.kind && item.id === candidate.id));
    },
  });

  assert.deepEqual(removed, ['qubicl-one']);
  assert.deepEqual(result.removed.map(({ name }) => name), ['qubicl-one']);
  assert.deepEqual(result.preserved.map(({ candidate }) => candidate.name), ['qubicl-two-control']);
  assert.match(result.preserved[0]!.detail, /running/);
  assert.deepEqual(result.failed.map(({ candidate, detail }) => [candidate.name, detail]), [
    ['qubicl-three', 'Docker preserved the reviewed container'],
  ]);
  assert.equal(replans, 4, 'one whole-plan check plus one immediate revalidation per reviewed candidate');
  assert.throws(() => assertCleanupSucceeded(result), /Cleanup was partial/);
});

test('cleanup Docker inventory rejects prefixes, duplicates, and substituted inspection identities', () => {
  const full = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const pattern = /^[a-f0-9]{64}$/;
  assert.deepEqual(parseIdentifierLines(`${full}\n${other}\n`, 'container inventory', pattern), [full, other]);
  assert.throws(() => parseIdentifierLines(`${full.slice(0, 12)}\n`, 'container inventory', pattern), /invalid identifier/);
  assert.throws(() => parseIdentifierLines(`${full}\n${full}\n`, 'container inventory', pattern), /duplicate identifiers/);
  assert.doesNotThrow(() => assertExactInspectionIdentitySet('container', [full, other], [{ Id: other }, { Id: full }]));
  assert.throws(() => assertExactInspectionIdentitySet('container', [full, other], [{ Id: full }, { Id: full }]), /duplicate identities/);
  assert.throws(() => assertExactInspectionIdentitySet('network', [full], [{ Id: other }]), /substituted/);
  assert.throws(() => assertExactInspectionIdentitySet('volume', ['qubicl-x11'], [{ Name: 'other-x11' }]), /substituted/);
});

test('orphan volumes remain manual because a reviewed Docker volume name can be replaced before removal', () => {
  const snapshot = cleanupSnapshot();
  const first = buildCleanupPlan(snapshot, allSelection());
  const replacement = snapshot.items.find((item) => item.kind === 'volume' && item.name === 'qubicl-old-x11');
  assert.ok(replacement?.kind === 'volume');
  replacement.labels = { ...replacement.labels };
  const second = buildCleanupPlan(snapshot, allSelection());
  assert.equal(first.candidates.some(({ kind }) => kind === 'volume'), false);
  assert.equal(second.candidates.some(({ kind }) => kind === 'volume'), false);
  assert.equal(second.preserved.find(({ name }) => name === 'qubicl-old-x11')?.reason, 'mutable-identity');
});

test('official-looking and forged-label images remain manual because Docker image ownership is daemon-global', () => {
  const snapshot = cleanupSnapshot();
  const plan = buildCleanupPlan(snapshot, allSelection());
  const imageCandidates = plan.candidates.filter(({ kind }) => kind === 'image');
  assert.deepEqual(imageCandidates, []);
  assert.equal(plan.preserved.find(({ name }) => name === 'stale-qubicl-image')?.reason, 'shared-global-image');
  assert.equal(plan.preserved.find(({ name }) => name === 'forged-label-image')?.reason, 'shared-global-image');
  assert.match(
    plan.preserved.find(({ name }) => name === 'forged-label-image')?.detail ?? '',
    /another Qubicl installation.*do not prove exclusive ownership/,
  );
});

const INSTALLATION = '00000000-0000-4000-8000-000000000000';

function cleanupSnapshot(): CleanupSnapshot {
  const currentImage = qubiclImage('1', 'current-qubicl-image');
  const retainedImage = qubiclImage('2', 'retained-qubicl-image');
  const runningImage = qubiclImage('3', 'running-image');
  runningImage.referencedByContainers = [{ containerId: 'running', running: true }];
  const stoppedImage = qubiclImage('4', 'stopped-image');
  stoppedImage.referencedByContainers = [{ containerId: 'stopped', running: false }];
  const globalDangling: CleanupImage = {
    kind: 'image',
    id: sha('5'),
    name: 'global-dangling-image',
    labels: {},
    references: [],
    referencedByContainers: [],
  };
  return {
    installationId: INSTALLATION,
    projectName: 'qubicl',
    expectedContainers: new Set(['qubicl-current-computer']),
    expectedNetworks: new Set(['qubicl-current-control']),
    expectedVolumes: new Set(['qubicl-current-x11']),
    protectedImageReferences: new Set([currentImage.id]),
    retainedManagedImageReferences: new Set(retainedImage.references),
    items: [
      container('current', 'qubicl-current-computer', 'running'),
      container('orphan', 'qubicl-old-computer', 'exited'),
      container('running', 'qubicl-running-orphan', 'running'),
      { ...container('unrelated', 'unrelated-container', 'exited'), labels: {} },
      network('old-network', 'qubicl-old-control'),
      { ...network('attached-network', 'qubicl-attached-control'), attachedContainers: [{ containerId: 'live', running: true }] },
      volume('old-volume', 'qubicl-old-x11'),
      { ...volume('home', 'qubicl-home'), durableHome: true },
      { ...volume('unrelated-volume', 'unrelated-volume'), labels: {} },
      qubiclImage('0', 'stale-qubicl-image'),
      { ...qubiclImage('6', 'forged-label-image'), references: [] },
      currentImage,
      retainedImage,
      runningImage,
      stoppedImage,
      globalDangling,
      record('cache-record', 'old-contract', true, false),
      record('evidence-record', 'old-acquisition', true, false),
      record('cache-record', 'current-contract', true, true),
      { ...record('cache-record', 'unknown-record-version', true, false), schemaVersion: 2 },
    ],
  };
}

function container(id: string, name: string, status: string): CleanupInventoryItem & { kind: 'container' } {
  return {
    kind: 'container',
    id,
    name,
    status,
    labels: {
      'dev.qubicl.installation': INSTALLATION,
      'dev.qubicl.role': 'computer',
      'dev.qubicl.id': '10000000-0000-4000-8000-000000000001',
    },
  };
}

function network(id: string, name: string): CleanupInventoryItem & { kind: 'network' } {
  return {
    kind: 'network',
    id,
    name,
    labels: {
      'com.docker.compose.project': 'qubicl',
      'com.docker.compose.network': 'control',
    },
    attachedContainers: [],
  };
}

function volume(id: string, name: string): CleanupInventoryItem & { kind: 'volume' } {
  return {
    kind: 'volume',
    id,
    name,
    labels: {
      'com.docker.compose.project': 'qubicl',
      'com.docker.compose.volume': 'display',
    },
    attachedContainers: [],
    durableHome: false,
  };
}

function qubiclImage(character: string, name: string): CleanupImage {
  return {
    kind: 'image',
    id: sha(character),
    name,
    labels: {
      'org.opencontainers.image.source': 'https://github.com/EldanRing/qubicl',
      'org.opencontainers.image.licenses': 'Apache-2.0',
      'org.opencontainers.image.title': 'Qubicl computer',
      'dev.qubicl.contract-version': '1',
      'dev.qubicl.preset': 'browser',
      'dev.qubicl.compatibility': 'browser',
      'dev.qubicl.manifest-sha256': 'a'.repeat(64),
    },
    references: [`registry.example/qubicl/browser@${sha(character)}`],
    referencedByContainers: [],
  };
}

function record(
  kind: 'cache-record' | 'evidence-record',
  name: string,
  obsolete: boolean,
  referenced: boolean,
): CleanupInventoryItem & { kind: 'cache-record' | 'evidence-record' } {
  return {
    kind,
    id: name,
    name,
    namespace: 'qubicl-runtime',
    schemaVersion: 1,
    obsolete,
    referenced,
  };
}

function allSelection(): CleanupSelection {
  return { orphans: true, images: true, records: true };
}

function cloneSnapshot(snapshot: CleanupSnapshot): CleanupSnapshot {
  return structuredClone(snapshot);
}

function sha(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
