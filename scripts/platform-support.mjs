import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLATFORM_SUPPORT_REQUIREMENTS_NAME = 'platform-support-v1.json';
export const PLATFORM_SUPPORT_REQUIREMENTS_PATH = resolve(
  fileURLToPath(new URL(`../conformance/${PLATFORM_SUPPORT_REQUIREMENTS_NAME}`, import.meta.url)),
);

const COMMON_VERSION_FIELDS = ['osVersion', 'node', 'dockerEngine', 'dockerCompose'];
const COMMON_CHECKS = ['minimumVersionsPassed', 'restartPassed', 'physicalRebootPassed'];
const WINDOWS_CHECKS = [
  ...COMMON_CHECKS,
  'dockerDesktopRestartPassed',
  'wslShutdownPassed',
  'windowsHostRebootPassed',
  'linuxFilesystemPassed',
  'windowsBackedStateRejected',
  'windowsLocalhostPassed',
  'windowsStdioPassed',
  'viewerHandoffPassed',
];
const requiredValues = (hostOs, architecture, executionMode) => ({
  hostOs,
  architecture,
  executionMode,
  computerRuntime: 'linux-container',
});
const platform = ({
  id,
  supportLevel,
  validationLevel,
  evidenceBaseline,
  hostOs,
  architecture,
  executionMode = 'native',
  requiredVersionFields = COMMON_VERSION_FIELDS,
  nullableVersionFields = [],
  requiredPrefixes = {},
  requiredChecks = COMMON_CHECKS,
}) => ({
  id,
  supportLevel,
  validationLevel,
  evidenceBaseline,
  requiredValues: requiredValues(hostOs, architecture, executionMode),
  requiredVersionFields,
  nullableVersionFields,
  requiredPrefixes,
  requiredChecks,
});
const EXPECTED_REQUIREMENTS = {
  schemaVersion: 1,
  id: 'qubicl-platform-support',
  acceptanceSchemaVersion: 4,
  statusVocabulary: {
    supportLevels: ['supported', 'best-effort', 'unsupported'],
    validationLevels: ['directly-tested', 'not-directly-tested'],
  },
  acceptancePlatforms: [
    platform({
      id: 'linux-x64', supportLevel: 'supported', validationLevel: 'directly-tested', evidenceBaseline: 'v0.1.0',
      hostOs: 'linux', architecture: 'x64', nullableVersionFields: ['dockerDesktop'],
    }),
    platform({
      id: 'linux-arm64', supportLevel: 'best-effort', validationLevel: 'not-directly-tested', evidenceBaseline: null,
      hostOs: 'linux', architecture: 'arm64', nullableVersionFields: ['dockerDesktop'],
    }),
    platform({
      id: 'macos-intel', supportLevel: 'best-effort', validationLevel: 'not-directly-tested', evidenceBaseline: null,
      hostOs: 'macos', architecture: 'x64',
      requiredVersionFields: [...COMMON_VERSION_FIELDS, 'dockerDesktop'],
      requiredChecks: [...COMMON_CHECKS, 'dockerDesktopRestartPassed'],
    }),
    platform({
      id: 'macos-apple-silicon', supportLevel: 'supported', validationLevel: 'directly-tested', evidenceBaseline: 'v0.1.0',
      hostOs: 'macos', architecture: 'arm64',
      requiredVersionFields: [...COMMON_VERSION_FIELDS, 'dockerDesktop'],
      requiredChecks: [...COMMON_CHECKS, 'dockerDesktopRestartPassed'],
    }),
    platform({
      id: 'windows-wsl2-x64', supportLevel: 'supported', validationLevel: 'directly-tested', evidenceBaseline: 'v0.1.0',
      hostOs: 'windows', architecture: 'x64', executionMode: 'wsl2',
      requiredVersionFields: [
        'osVersion', 'windowsBuild', 'wslVersion', 'wslKernel', 'distribution',
        'node', 'dockerEngine', 'dockerCompose', 'dockerDesktop',
      ],
      requiredPrefixes: { osVersion: 'Windows 11', distribution: 'Ubuntu 24.04' },
      requiredChecks: WINDOWS_CHECKS,
    }),
  ],
  additionalHostClaims: [
    {
      id: 'windows-wsl2-x64-other-distribution',
      supportLevel: 'best-effort', validationLevel: 'not-directly-tested',
      hostOs: 'windows', architecture: 'x64', executionMode: 'wsl2',
    },
    {
      id: 'windows-wsl2-arm64',
      supportLevel: 'best-effort', validationLevel: 'not-directly-tested',
      hostOs: 'windows', architecture: 'arm64', executionMode: 'wsl2',
    },
  ],
  boundaries: [
    {
      id: 'native-windows-cli', scope: 'host-execution',
      supportLevel: 'unsupported', validationLevel: 'not-directly-tested',
    },
    {
      id: 'wsl1', scope: 'host-execution',
      supportLevel: 'unsupported', validationLevel: 'not-directly-tested',
    },
    {
      id: 'computer-runtime-linux-container', scope: 'computer-runtime',
      supportLevel: 'supported', validationLevel: 'directly-tested', runtimeOs: 'linux',
      nativeHostWorkload: false, vmSecurityBoundary: false,
    },
  ],
};

export async function loadPlatformSupportRequirements(path = PLATFORM_SUPPORT_REQUIREMENTS_PATH) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  assertPlatformSupportRequirements(document);
  return document;
}

export function assertPlatformSupportRequirements(document) {
  assert(canonicalJson(document) === canonicalJson(EXPECTED_REQUIREMENTS),
    'Platform support requirements do not match the supported version-1 contract.');
  return document;
}

export async function validatePlatformConformance(evidence, requirements, validateResult, selection = {}) {
  assert(evidence?.platformConformance?.schemaVersion === 1,
    'Acceptance schema 4 requires platform conformance schemaVersion 1.');
  const profiles = selectedPlatformProfiles(requirements.acceptancePlatforms, selection.platforms);
  const rows = evidence.platforms;
  assert(Array.isArray(rows) && rows.length === profiles.length,
    `Platform conformance requires exactly ${profiles.length} platform rows.`);
  for (const requirement of profiles) {
    const matches = rows.filter((row) => row?.id === requirement.id);
    assert(matches.length === 1, `Expected exactly one platform row for ${requirement.id}.`);
    const row = matches[0];
    await validateResult(row, `platform ${requirement.id}`);
    for (const [field, expected] of Object.entries(requirement.requiredValues)) {
      assert(row[field] === expected, `platform ${requirement.id} must record ${field} as ${expected}.`);
    }
    for (const field of requirement.requiredVersionFields) {
      assert(exactRecordedVersion(row[field]), `platform ${requirement.id} requires exact ${field}.`);
    }
    for (const field of requirement.nullableVersionFields) {
      assert(row[field] === null || exactRecordedVersion(row[field]),
        `platform ${requirement.id} requires exact or null ${field}.`);
    }
    for (const [field, prefix] of Object.entries(requirement.requiredPrefixes)) {
      assert(row[field].startsWith(prefix), `platform ${requirement.id} ${field} must identify ${prefix}.`);
    }
    const requiredChecks = selection.requiredChecks?.[requirement.id] ?? requirement.requiredChecks;
    for (const field of requiredChecks) {
      assert(requirement.requiredChecks.includes(field),
        `Acceptance profile names unsupported platform check ${field} for ${requirement.id}.`);
      assert(row[field] === true, `platform ${requirement.id} requires ${field}.`);
    }
  }
  return { platforms: profiles.length };
}

function selectedPlatformProfiles(profiles, selectedIds) {
  if (selectedIds === undefined) return profiles;
  assert(Array.isArray(selectedIds) && new Set(selectedIds).size === selectedIds.length,
    'Acceptance profile has duplicate platform requirements.');
  return selectedIds.map((id) => {
    const matches = profiles.filter((profile) => profile.id === id);
    assert(matches.length === 1, `Acceptance profile names unsupported platform ${id}.`);
    return matches[0];
  });
}

export function exactRecordedVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 2 || value.length > 200 || !/\d/u.test(value)) return false;
  if ([...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) return false;
  if (/[<>=*^~|&]/u.test(value)) return false;
  if (/\b(?:or|through)\b/iu.test(value) || /\s[-–—]\s/u.test(value)) return false;
  if (/\b(?:latest|current|unknown|unversioned|development|nightly|canary|snapshot)\b/iu.test(value)) return false;
  return !/(?:^|[.\s_-])x(?:$|[.\s_-])/iu.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
