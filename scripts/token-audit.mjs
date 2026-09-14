import {
  compactToolDefinitionBytes,
  enabledToolNames,
  PRESET_DEFINITIONS,
} from '../packages/core/dist/index.js';

const profiles = ['full', 'files', 'browser-semantic', 'browser-visual', 'desktop'];
const WORKSTATION_BUDGET_BYTES = 38_000;
const rows = [];
for (const preset of Object.keys(PRESET_DEFINITIONS)) {
  const enabled = enabledToolNames(PRESET_DEFINITIONS[preset].capabilities);
  rows.push({
    preset,
    directBytes: compactToolDefinitionBytes(enabled),
    transparentBytes: compactToolDefinitionBytes(enabled, { leaseTransparent: true }),
    profiles: Object.fromEntries(profiles.map((profile) => [
      profile,
      compactToolDefinitionBytes(enabled, { leaseTransparent: true, profile }),
    ])),
  });
}

const workstation = rows.find(({ preset }) => preset === 'workstation');
if (!workstation || workstation.transparentBytes >= WORKSTATION_BUDGET_BYTES) {
  throw new Error(`Lease-transparent workstation catalog exceeds the ${WORKSTATION_BUDGET_BYTES.toLocaleString('en-US')}-byte budget: ${workstation?.transparentBytes ?? 'missing'}.`);
}

console.log(JSON.stringify({
  measurement: 'compact JSON tool definitions (name, description, inputSchema)',
  estimatedTokens: 'ceil(bytes / 4)',
  workstationBudgetBytes: WORKSTATION_BUDGET_BYTES,
  rows: rows.map((row) => ({
    ...row,
    directEstimatedTokens: Math.ceil(row.directBytes / 4),
    transparentEstimatedTokens: Math.ceil(row.transparentBytes / 4),
  })),
}, null, 2));
