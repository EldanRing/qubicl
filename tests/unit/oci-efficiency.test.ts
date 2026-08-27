import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const exec = promisify(execFile);
const root = process.cwd();
const efficiencyScript = join(root, 'scripts', 'oci-efficiency.mjs');
const efficiencyModule = pathToFileURL(efficiencyScript).href;
const evidenceModule = pathToFileURL(join(root, 'scripts', 'oci-evidence.mjs')).href;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip';
const OCI_EMPTY = 'application/vnd.oci.empty.v1+json';
const IN_TOTO = 'application/vnd.in-toto+json';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const SPDX_DOCUMENT = 'https://spdx.dev/Document';

test('efficiency report partitions shared and unique layer bytes per platform', async () => {
  const { buildOciEfficiencyReport, serializeOciEfficiencyReport } = await import(efficiencyModule);
  const inspections = inspectionFixture();
  const report = buildOciEfficiencyReport(inspections);
  const platform = report.platforms['linux/amd64'];

  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(Object.keys(report.images), ['gateway', 'file-system', 'browser', 'computer', 'workstation']);
  assert.deepEqual(platform.compressedLayerBytes, {
    logical: 213,
    deduplicated: 86,
    shared: 57,
    unique: 29,
    duplicate: 127,
  });
  assert.deepEqual(platform.expandedLayerBytes, {
    logical: 2130,
    deduplicated: 860,
    shared: 570,
    unique: 290,
    duplicate: 1270,
  });
  assert.deepEqual(platform.images.browser.compressedLayerBytes, { total: 55, shared: 50, unique: 5 });
  assert.deepEqual(platform.images.computer.expandedLayerBytes, { total: 570, shared: 570, unique: 0 });
  assert.deepEqual(platform.packageCounts, {
    logical: 20,
    deduplicated: 7,
    shared: 5,
    unique: 2,
    duplicate: 13,
  });
  assert.deepEqual(platform.images.gateway.packageCounts, { total: 2, shared: 1, unique: 1 });
  assert.deepEqual(platform.images.browser.packageCounts, { total: 4, shared: 4, unique: 0 });
  assert.deepEqual(platform.packages.find(({ name }: { name: string }) => name === 'chromium').images,
    ['browser', 'computer', 'workstation']);
  assert.deepEqual(
    platform.images.workstation.layers.map(({ position, digest: value }: { position: number; digest: string }) => [position, value]),
    [[0, digest('base')], [1, digest('display')], [2, digest('desktop')], [3, digest('workstation')]],
  );
  assert.deepEqual(
    platform.compressedLayers.find(({ digest: value }: { digest: string }) => value === digest('desktop')).images,
    ['computer', 'workstation'],
  );

  const reordered = Object.fromEntries(Object.entries(inspections).toReversed());
  assert.deepEqual(buildOciEfficiencyReport(reordered), report, 'input object order does not affect the report');

  const serialized = serializeOciEfficiencyReport(report);
  assert.deepEqual(JSON.parse(serialized), report);
  assert.throws(() => serializeOciEfficiencyReport(report, { maximumBytes: Buffer.byteLength(serialized) - 1 }),
    /serialized budget/);
});

test('compressed and expanded sharing are accounted by their respective digests', async () => {
  const { buildOciEfficiencyReport } = await import(efficiencyModule);
  const inspections = inspectionFixture();
  const gatewayLayer = inspections.gateway.platforms['linux/amd64'].layers[0];
  const fileSystemLayer = inspections['file-system'].platforms['linux/amd64'].layers[1];
  fileSystemLayer.diffId = gatewayLayer.diffId;
  fileSystemLayer.expandedBytes = gatewayLayer.expandedBytes;
  inspections['file-system'].platforms['linux/amd64'].diffIds[1] = gatewayLayer.diffId;
  inspections['file-system'].platforms['linux/amd64'].expandedBytes = 300;

  const platform = buildOciEfficiencyReport(inspections).platforms['linux/amd64'];
  assert.equal(platform.compressedLayers.find(({ digest: value }: { digest: string }) => value === gatewayLayer.digest).images.length, 1);
  const recompressed = platform.expandedLayers.find(({ diffId }: { diffId: string }) => diffId === gatewayLayer.diffId);
  assert.deepEqual(recompressed.images, ['gateway', 'file-system']);
  assert.deepEqual(recompressed.digests, [fileSystemLayer.digest, gatewayLayer.digest].sort());
});

test('efficiency reports reject missing, duplicate, or unsafe package identities', async () => {
  const { buildOciEfficiencyReport } = await import(efficiencyModule);
  const missing = inspectionFixture();
  delete missing.gateway.platforms['linux/amd64'].packages;
  assert.throws(() => buildOciEfficiencyReport(missing), /has no SPDX package inventory/);

  const duplicate = inspectionFixture();
  duplicate.gateway.platforms['linux/amd64'].packages.push(
    structuredClone(duplicate.gateway.platforms['linux/amd64'].packages[0]),
  );
  assert.throws(() => buildOciEfficiencyReport(duplicate), /duplicate package identity/);

  const unsafe = inspectionFixture();
  unsafe.gateway.platforms['linux/amd64'].packages[0].purls = ['pkg:generic/unsafe package@1'];
  assert.throws(() => buildOciEfficiencyReport(unsafe), /invalid purls/);

  const tooManyLayers = inspectionFixture();
  tooManyLayers.gateway.platforms['linux/amd64'].layers = Array.from(
    { length: 4097 },
    () => tooManyLayers.gateway.platforms['linux/amd64'].layers[0],
  );
  assert.throws(() => buildOciEfficiencyReport(tooManyLayers), /between 1 and 4096 measured layers/);
});

test('archive inspection exposes opt-in layer measurements without changing default evidence', async (context) => {
  const { inspectOciEfficiencyArchives, OCI_EFFICIENCY_IMAGE_NAMES, parseOciEfficiencyArgs } = await import(efficiencyModule);
  const { inspectOciArchive } = await import(evidenceModule);
  const fixture = await createOciArchive(context);

  const ordinary = await inspectOciArchive(fixture.archive);
  assert.equal('layers' in ordinary.platforms['linux/amd64'], false);
  const measured = await inspectOciArchive(fixture.archive, { includeLayerMeasurements: true });
  assert.deepEqual(measured.platforms['linux/amd64'].layers, [fixture.layers['linux/amd64']]);
  const withoutLayerMeasurements = structuredClone(measured);
  for (const variant of Object.values(withoutLayerMeasurements.platforms) as Array<Record<string, unknown>>) {
    delete variant.layers;
  }
  assert.deepEqual(withoutLayerMeasurements, ordinary, 'default evidence values and schema remain unchanged');

  const archives = Object.fromEntries(OCI_EFFICIENCY_IMAGE_NAMES.map((name: string) => [name, fixture.archive]));
  const report = await inspectOciEfficiencyArchives(archives);
  const amd64 = report.platforms['linux/amd64'];
  const amd64Layer = fixture.layers['linux/amd64'];
  assert.ok(amd64Layer);
  assert.equal(amd64.compressedLayers.length, 1);
  assert.deepEqual(amd64.compressedLayers[0].images, OCI_EFFICIENCY_IMAGE_NAMES);
  assert.equal(amd64.compressedLayerBytes.logical, amd64Layer.compressedBytes * 5);
  assert.equal(amd64.compressedLayerBytes.deduplicated, amd64Layer.compressedBytes);
  assert.equal(amd64.compressedLayerBytes.unique, 0);
  assert.deepEqual(amd64.packageCounts, { logical: 10, deduplicated: 2, shared: 2, unique: 0, duplicate: 8 });
  assert.equal(amd64.packages.some(({ name }: { name: string }) => name === 'sbom'), false,
    'BuildKit/Syft document-root packages are not counted as installed packages');

  const args = OCI_EFFICIENCY_IMAGE_NAMES.flatMap((name: string) => [
    `--${name}`,
    fixture.archive,
  ]);
  assert.deepEqual(parseOciEfficiencyArgs(args), archives);
  const cliReport = JSON.parse((await exec(process.execPath, [efficiencyScript, ...args])).stdout);
  assert.deepEqual(cliReport, report);
  assert.throws(() => parseOciEfficiencyArgs(['--gateway', fixture.archive]), /must contain exactly/);

  const oversized = await createOciArchive(context, { manifestLayerCount: 4097 });
  await assert.rejects(inspectOciArchive(oversized.archive), /between 1 and 4096 layers/);
});

function inspectionFixture(): Record<string, any> {
  const base = layer('base', 20, 200);
  const display = layer('display', 30, 300);
  const desktop = layer('desktop', 7, 70);
  const packageSets: Record<string, Array<ReturnType<typeof imagePackage>>> = {
    gateway: [imagePackage('alpine-base', '3.22'), imagePackage('node', '22.14.0')],
    'file-system': [imagePackage('debian-base', '13'), imagePackage('node', '22.14.0'), imagePackage('curl', '8.14.1')],
    browser: [imagePackage('debian-base', '13'), imagePackage('node', '22.14.0'), imagePackage('curl', '8.14.1'), imagePackage('chromium', '140.0')],
    computer: [imagePackage('debian-base', '13'), imagePackage('node', '22.14.0'), imagePackage('curl', '8.14.1'), imagePackage('chromium', '140.0'), imagePackage('xfce', '4.20')],
    workstation: [imagePackage('debian-base', '13'), imagePackage('node', '22.14.0'), imagePackage('curl', '8.14.1'), imagePackage('chromium', '140.0'), imagePackage('xfce', '4.20'), imagePackage('libreoffice', '25.2')],
  };
  return Object.fromEntries([
    ['gateway', [layer('gateway', 10, 100)]],
    ['file-system', [base, layer('file-system', 3, 30)]],
    ['browser', [base, display, layer('browser', 5, 50)]],
    ['computer', [base, display, desktop]],
    ['workstation', [base, display, desktop, layer('workstation', 11, 110)]],
  ].map(([name, layers]) => {
    const typedLayers = layers as Array<ReturnType<typeof layer>>;
    const compressedBytes = typedLayers.reduce((total, value) => total + value.compressedBytes, 0);
    const expandedBytes = typedLayers.reduce((total, value) => total + value.expandedBytes, 0);
    return [name, {
      indexDigest: digest(`${name}-index`),
      platforms: {
        'linux/amd64': {
          digest: digest(`${name}-manifest`),
          configDigest: digest(`${name}-config`),
          layerDigests: typedLayers.map(({ digest: value }) => value),
          diffIds: typedLayers.map(({ diffId }) => diffId),
          downloadBytes: compressedBytes + 2,
          expandedBytes,
          layers: typedLayers.map((value) => ({ ...value })),
          packages: packageSets[name as string],
        },
      },
    }];
  }));
}

function imagePackage(name: string, version: string) {
  return {
    name,
    version,
    purls: [`pkg:generic/${name}@${version}`],
  };
}

function layer(label: string, compressedBytes: number, expandedBytes: number) {
  return {
    digest: digest(label),
    diffId: digest(`${label}-expanded`),
    compressedBytes,
    expandedBytes,
  };
}

async function createOciArchive(context: TestContext, { manifestLayerCount = 1 } = {}): Promise<{
  archive: string;
  layers: Record<string, ReturnType<typeof layer>>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-oci-efficiency-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const layout = join(temporary, 'layout');
  const archive = join(temporary, 'fixture.oci.tar');
  await mkdir(join(layout, 'blobs', 'sha256'), { recursive: true });
  const manifests = [];
  const attestations = [];
  const layers: Record<string, ReturnType<typeof layer>> = {};
  for (const architecture of ['amd64', 'arm64']) {
    const platform = `linux/${architecture}`;
    const expanded = Buffer.from(`expanded-${architecture}-layer-content`);
    const compressed = gzipSync(expanded);
    const layerDescriptor = await blob(layout, compressed, OCI_LAYER);
    const diffId = `sha256:${createHash('sha256').update(expanded).digest('hex')}`;
    const config = await jsonBlob(layout, {
      architecture,
      os: 'linux',
      rootfs: { type: 'layers', diff_ids: [diffId] },
      config: {},
    }, OCI_CONFIG);
    const manifest = await jsonBlob(layout, {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config,
      layers: Array.from({ length: manifestLayerCount }, () => layerDescriptor),
    }, OCI_MANIFEST);
    manifests.push({ ...manifest, platform: { os: 'linux', architecture } });
    const subject = [{ name: 'fixture', digest: { sha256: manifest.digest.slice('sha256:'.length) } }];
    const provenance = await jsonBlob(layout, {
      _type: 'https://in-toto.io/Statement/v1',
      subject,
      predicateType: SLSA_PROVENANCE,
      predicate: {
        buildDefinition: {
          buildType: 'https://example.invalid/buildkit/v1',
          externalParameters: {
            configSource: { path: 'Dockerfile' },
            request: {
              frontend: 'dockerfile.v0',
              args: {},
              locals: [{ name: 'context' }, { name: 'dockerfile' }],
            },
          },
          resolvedDependencies: [{ uri: 'pkg:docker/fixture/base', digest: { sha256: 'a'.repeat(64) } }],
        },
        runDetails: { builder: { id: '' } },
      },
    }, IN_TOTO);
    const provenanceDescriptor = { ...provenance, annotations: { 'in-toto.io/predicate-type': SLSA_PROVENANCE } };
    const spdx = await jsonBlob(layout, {
      _type: 'https://in-toto.io/Statement/v1',
      subject,
      predicateType: SPDX_DOCUMENT,
      predicate: {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: `fixture-${architecture}`,
        documentNamespace: `https://example.invalid/spdx/${architecture}`,
        creationInfo: { created: '2026-08-27T00:00:00Z', creators: ['Tool: fixture'] },
        relationships: [{
          spdxElementId: 'SPDXRef-DOCUMENT',
          relationshipType: 'DESCRIBES',
          relatedSpdxElement: 'SPDXRef-DocumentRoot-Directory-sbom',
        }],
        packages: [
          { name: 'sbom', SPDXID: 'SPDXRef-DocumentRoot-Directory-sbom' },
          {
            name: 'node', SPDXID: 'SPDXRef-Package-node', versionInfo: '22.14.0',
            supplier: 'Organization: fixture', primaryPackagePurpose: 'APPLICATION',
            externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:generic/node@22.14.0' }],
          },
          {
            name: `architecture-${architecture}`, SPDXID: `SPDXRef-Package-${architecture}`, versionInfo: '1',
            supplier: 'Organization: fixture', primaryPackagePurpose: 'LIBRARY',
            externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:generic/architecture-${architecture}@1` }],
          },
        ],
      },
    }, IN_TOTO);
    const spdxDescriptor = { ...spdx, annotations: { 'in-toto.io/predicate-type': SPDX_DOCUMENT } };
    const emptyConfig = await blob(layout, Buffer.from('{}'), OCI_EMPTY);
    const attestation = await jsonBlob(layout, {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: emptyConfig,
      layers: [provenanceDescriptor, spdxDescriptor],
    }, OCI_MANIFEST);
    attestations.push({
      ...attestation,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: {
        'vnd.docker.reference.digest': manifest.digest,
        'vnd.docker.reference.type': 'attestation-manifest',
      },
    });
    layers[platform] = {
      digest: layerDescriptor.digest,
      diffId,
      compressedBytes: compressed.length,
      expandedBytes: expanded.length,
    };
  }
  const index = await jsonBlob(layout, { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [...manifests, ...attestations] }, OCI_INDEX);
  await writeFile(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
  await writeFile(join(layout, 'index.json'), `${JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [index],
  })}\n`);
  await exec('tar', ['-cf', archive, '-C', layout, 'oci-layout', 'index.json', 'blobs']);
  return { archive, layers };
}

async function jsonBlob(directory: string, value: unknown, mediaType: string) {
  return blob(directory, Buffer.from(JSON.stringify(value)), mediaType);
}

async function blob(directory: string, bytes: Buffer, mediaType: string) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'blobs', 'sha256', hash), bytes);
  return { mediaType, digest: `sha256:${hash}`, size: bytes.length };
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
