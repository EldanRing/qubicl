import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function collectBundledPackages(root, namedMetafiles) {
  const packages = new Map();
  for (const entry of namedMetafiles) {
    const bundle = entry.bundle ?? 'application';
    const metafile = entry.metafile ?? entry;
    for (const input of Object.keys(metafile.inputs ?? {})) {
      const directory = dependencyDirectory(root, input);
      if (!directory) continue;
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      assert(typeof manifest.name === 'string' && manifest.name.length > 0, `${directory}/package.json has no package name.`);
      assert(typeof manifest.version === 'string' && manifest.version.length > 0, `${manifest.name} has no package version.`);
      const key = `${manifest.name}@${manifest.version}`;
      const existing = packages.get(key);
      if (existing) {
        existing.bundles.add(bundle);
      } else {
        packages.set(key, { key, directory, manifest, bundles: new Set([bundle]) });
      }
    }
  }
  return [...packages.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => ({ ...entry, bundles: [...entry.bundles].sort() }));
}

export function generateSpdxDocument({
  name,
  version,
  revision,
  created,
  source,
  artifactKind,
  packages,
  extraPackages = [],
}) {
  const rootId = spdxId(name, version);
  const dependencies = [...packages.map(packageComponent), ...extraPackages]
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  const spdxPackages = [
    {
      name,
      SPDXID: rootId,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'Apache-2.0',
      licenseDeclared: 'Apache-2.0',
      copyrightText: 'NOASSERTION',
      externalRefs: [purlReference(`pkg:npm/${npmPurlName(name)}@${encodeURIComponent(version)}`)],
      comment: `Qubicl ${artifactKind} application assembled from the recorded esbuild metafiles.`,
    },
    ...dependencies.map((dependency) => ({
      name: dependency.name,
      SPDXID: dependency.SPDXID ?? spdxId(dependency.name, dependency.version),
      versionInfo: dependency.version,
      downloadLocation: dependency.downloadLocation ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: dependency.license ?? 'NOASSERTION',
      licenseDeclared: dependency.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: dependency.purl ? [purlReference(dependency.purl)] : [],
      ...(dependency.comment ? { comment: dependency.comment } : {}),
    })),
  ];
  const documentNamespace = `${normalizeSource(source)}/spdx/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(revision)}/${encodeURIComponent(artifactKind)}`;
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${name}-${version}-${artifactKind}`,
    documentNamespace,
    creationInfo: {
      created: spdxTimestamp(created),
      creators: ['Tool: qubicl-metafile-sbom-1'],
    },
    documentDescribes: [rootId],
    packages: spdxPackages,
    relationships: dependencies.map((dependency) => ({
      spdxElementId: rootId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: dependency.SPDXID ?? spdxId(dependency.name, dependency.version),
    })),
  };
}

export function nodeRuntimeComponent(version = process.versions.node) {
  return {
    name: 'node',
    version,
    license: 'MIT',
    purl: `pkg:generic/node@${encodeURIComponent(version)}`,
    comment: 'Exact Node.js runtime embedded in the native single-executable application.',
  };
}

export function assertSpdxPackages(document, packages, { allowAdditional = [] } = {}) {
  assert(document?.spdxVersion === 'SPDX-2.3', 'The bundle SBOM must use SPDX 2.3.');
  const described = new Set(document.documentDescribes ?? []);
  const actual = new Set((document.packages ?? [])
    .filter((entry) => !described.has(entry.SPDXID))
    .map((entry) => `${entry.name}@${entry.versionInfo}`));
  const expected = new Set(packages.map((entry) => entry.key ?? `${entry.name}@${entry.version}`));
  for (const key of allowAdditional) expected.add(key);
  assert(equalSets(actual, expected), `SBOM components do not match bundled components. Expected ${[...expected].sort().join(', ')}; found ${[...actual].sort().join(', ')}.`);
}

export function spdxPackageKeys(document, { includeDescribed = false } = {}) {
  const described = new Set(document.documentDescribes ?? []);
  return (document.packages ?? [])
    .filter((entry) => includeDescribed || !described.has(entry.SPDXID))
    .map((entry) => `${entry.name}@${entry.versionInfo}`)
    .sort();
}

function packageComponent(entry) {
  const license = typeof entry.manifest.license === 'string' ? entry.manifest.license : 'NOASSERTION';
  return {
    name: entry.manifest.name,
    version: entry.manifest.version,
    license,
    purl: `pkg:npm/${npmPurlName(entry.manifest.name)}@${encodeURIComponent(entry.manifest.version)}`,
    comment: `Bundled into: ${entry.bundles.join(', ')}.`,
  };
}

function purlReference(locator) {
  return {
    referenceCategory: 'PACKAGE-MANAGER',
    referenceType: 'purl',
    referenceLocator: locator,
  };
}

function npmPurlName(name) {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const [scope, packageName] = name.split('/');
  assert(scope && packageName, `Invalid scoped npm package name ${name}.`);
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
}

function spdxId(name, version) {
  const readable = `${name}-${version}`.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 12);
  return `SPDXRef-Package-${readable}-${suffix}`;
}

function spdxTimestamp(value) {
  const parsed = new Date(value);
  assert(Number.isFinite(parsed.getTime()), `Invalid SPDX creation timestamp ${JSON.stringify(value)}.`);
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeSource(source) {
  assert(typeof source === 'string' && source.startsWith('https://'), `Invalid SPDX source namespace ${JSON.stringify(source)}.`);
  return source.replace(/\.git$/, '').replace(/\/$/, '');
}

function dependencyDirectory(root, input) {
  const normalized = input.replaceAll('\\', '/');
  let searchFrom = 0;
  let found;
  while (true) {
    const marker = normalized.indexOf('node_modules/', searchFrom);
    if (marker === -1) break;
    const packageStart = marker + 'node_modules/'.length;
    const parts = normalized.slice(packageStart).split('/');
    const packageName = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (packageName) found = normalized.slice(0, packageStart) + packageName;
    searchFrom = packageStart;
  }
  return found ? resolve(root, found) : undefined;
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
