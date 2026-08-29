import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_CONFORMANCE_REQUIREMENTS_NAME = 'client-conformance-v1.json';
export const CLIENT_CONFORMANCE_REQUIREMENTS_PATH = resolve(
  fileURLToPath(new URL(`../conformance/${CLIENT_CONFORMANCE_REQUIREMENTS_NAME}`, import.meta.url)),
);

const SURFACES = [
  'discovery',
  'mcp-stdio',
  'mcp-http',
  'openapi',
  'open-terminal',
  'result-modes',
  'screenshots',
  'files',
  'browser-control',
  'human-takeover',
];
const STDIO_SURFACES = ['discovery', 'mcp-stdio', 'result-modes', 'screenshots', 'files', 'browser-control', 'human-takeover'];
const OPENAPI_SURFACES = ['discovery', 'openapi', 'result-modes', 'screenshots', 'files', 'browser-control', 'human-takeover'];
const OPEN_TERMINAL_SURFACES = ['discovery', 'openapi', 'open-terminal', 'result-modes', 'screenshots', 'files', 'browser-control', 'human-takeover'];
const profile = (id, transport, requiredSurfaces) => ({ id, transport, requiredSurfaces });
const EXPECTED_REQUIREMENTS = {
  schemaVersion: 1,
  id: 'qubicl-client-conformance',
  acceptanceSchemaVersion: 4,
  requiredPreset: 'workstation',
  surfaces: SURFACES,
  clients: [
    profile('codex', 'mcp-stdio', STDIO_SURFACES),
    profile('claude-code', 'mcp-stdio', STDIO_SURFACES),
    profile('opencode', 'mcp-stdio', STDIO_SURFACES),
    profile('openclaw', 'mcp-stdio', STDIO_SURFACES),
    profile('hermes-agent', 'mcp-stdio', STDIO_SURFACES),
    profile('open-webui', 'open-terminal', OPEN_TERMINAL_SURFACES),
    profile('claude-desktop', 'mcp-stdio', STDIO_SURFACES),
    profile('cursor', 'mcp-stdio', STDIO_SURFACES),
    profile('vscode', 'mcp-stdio', STDIO_SURFACES),
  ],
  protocols: [
    profile('mcp-stdio', 'mcp-stdio', STDIO_SURFACES),
    profile('mcp-http', 'mcp-http', ['discovery', 'mcp-http', 'result-modes', 'screenshots', 'files', 'browser-control', 'human-takeover']),
    profile('openapi', 'openapi', OPENAPI_SURFACES),
    profile('open-terminal', 'open-terminal', OPEN_TERMINAL_SURFACES),
  ],
};

export async function loadClientConformanceRequirements(path = CLIENT_CONFORMANCE_REQUIREMENTS_PATH) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  assertClientConformanceRequirements(document);
  return document;
}

export function assertClientConformanceRequirements(document) {
  assert(canonicalJson(document) === canonicalJson(EXPECTED_REQUIREMENTS),
    'Client conformance requirements do not match the supported version-1 contract.');
  return document;
}

export async function validateClientConformance(evidence, requirements, validateResult, selection = {}) {
  assert(evidence?.conformance?.schemaVersion === 1, 'Acceptance schema 4 requires client conformance schemaVersion 1.');
  const clients = selectedProfiles(requirements.clients, selection.clients, 'client');
  const protocols = selectedProfiles(requirements.protocols, selection.protocols, 'protocol');
  const clientSurfaces = await validateRows(evidence.clients, clients, 'client', requirements.requiredPreset, validateResult);
  const protocolSurfaces = await validateRows(evidence.protocols, protocols, 'protocol', requirements.requiredPreset, validateResult);
  return {
    clients: clients.length,
    protocols: protocols.length,
    surfaces: clientSurfaces + protocolSurfaces,
  };
}

function selectedProfiles(profiles, selectedIds, label) {
  if (selectedIds === undefined) return profiles;
  assert(Array.isArray(selectedIds) && new Set(selectedIds).size === selectedIds.length,
    `Acceptance profile has duplicate ${label} requirements.`);
  return selectedIds.map((id) => {
    const matches = profiles.filter((profile) => profile.id === id);
    assert(matches.length === 1, `Acceptance profile names unsupported ${label} ${id}.`);
    return matches[0];
  });
}

export function clientConformanceEvidenceReferences(evidence) {
  const rows = [...(evidence.clients ?? []), ...(evidence.protocols ?? [])];
  return rows.flatMap((row) => [
    row?.evidence,
    ...Object.values(row?.surfaces ?? {}).map((result) => result?.evidence),
  ]);
}

export function requiresClientConformance(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.exec(version ?? '');
  assert(match, `Release version ${version ?? 'unknown'} is not valid Semantic Versioning.`);
  return Number(match[1]) > 0 || Number(match[2]) >= 2;
}

export function exactClientVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 3 || value.length > 160 || !/\d/u.test(value)) return false;
  if ([...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) return false;
  if (/[<>=*^~|&]/u.test(value)) return false;
  if (/\b(?:or|through)\b/iu.test(value) || /\s[-–—]\s/u.test(value)) return false;
  if (/\b(?:latest|current|unknown|unversioned|development|nightly|canary|snapshot)\b/iu.test(value)) return false;
  return !/(?:^|[.\s_-])x(?:$|[.\s_-])/iu.test(value);
}

async function validateRows(rows, profiles, label, requiredPreset, validateResult) {
  assert(Array.isArray(rows) && rows.length === profiles.length,
    `Client conformance requires exactly ${profiles.length} ${label} rows.`);
  let surfaces = 0;
  for (const requirement of profiles) {
    const matches = rows.filter((row) => row?.id === requirement.id);
    assert(matches.length === 1, `Expected exactly one ${label} row for ${requirement.id}.`);
    const row = matches[0];
    assert(exactClientVersion(row.version), `${label} ${requirement.id} requires an exact installed version.`);
    assert(row.transport === requirement.transport, `${label} ${requirement.id} must use ${requirement.transport}.`);
    assert(row.preset === requiredPreset, `${label} ${requirement.id} must be exercised on the ${requiredPreset} preset.`);
    await validateResult(row, `${label} ${requirement.id}`);
    const actualSurfaces = Object.keys(row.surfaces ?? {}).sort();
    const expectedSurfaces = [...requirement.requiredSurfaces].sort();
    assert(canonicalJson(actualSurfaces) === canonicalJson(expectedSurfaces),
      `${label} ${requirement.id} must report exactly its applicable conformance surfaces.`);
    for (const surface of requirement.requiredSurfaces) {
      await validateResult(row.surfaces[surface], `${label} ${requirement.id} surface ${surface}`);
      surfaces += 1;
    }
  }
  return surfaces;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
