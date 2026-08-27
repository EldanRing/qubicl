import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ComputerDefaultsSchema, IMAGE_CATALOG, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, stringOption } from './args.js';
import { addConfiguredComputer } from './computers.js';
import { acquireCustomImage, docker, ensureRuntimeImages, validateDocker } from './docker.js';
import { loadState, statePaths, withStateLock } from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';

interface DevcontainerDocument {
  name?: unknown;
  image?: unknown;
  build?: unknown;
  containerEnv?: unknown;
  remoteEnv?: unknown;
  workspaceFolder?: unknown;
  [key: string]: unknown;
}

const REJECTED = [
  'privileged', 'capAdd', 'securityOpt', 'mounts', 'runArgs', 'containerUser', 'remoteUser',
  'initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand',
  'postStartCommand', 'postAttachCommand', 'dockerComposeFile', 'service', 'shutdownAction',
  'hostRequirements', 'forwardPorts', 'portsAttributes', 'otherPortsAttributes', 'features',
];

function parseJsonc(source: string): unknown {
  let output = ''; let quote = false; let escape = false; let line = false; let block = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!; const next = source[index + 1];
    if (line) { if (char === '\n') { line = false; output += char; } else output += ' '; continue; }
    if (block) { if (char === '*' && next === '/') { block = false; output += '  '; index += 1; } else output += char === '\n' ? '\n' : ' '; continue; }
    if (!quote && char === '/' && next === '/') { line = true; output += '  '; index += 1; continue; }
    if (!quote && char === '/' && next === '*') { block = true; output += '  '; index += 1; continue; }
    output += char;
    if (quote) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') quote = false; }
    else if (char === '"') quote = true;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/gu, '$1'));
}

async function loadDocument(directory: string): Promise<{ root: string; path: string; document: DevcontainerDocument }> {
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory.`);
  const nested = join(root, '.devcontainer', 'devcontainer.json');
  const direct = join(root, 'devcontainer.json');
  let path = nested;
  try { await lstat(nested); } catch { path = direct; }
  const parsed = parseJsonc(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('devcontainer.json must contain an object.');
  const document = parsed as DevcontainerDocument;
  const rejected = REJECTED.filter((key) => document[key] !== undefined);
  if (rejected.length) throw new Error(`Unsupported or unsafe devcontainer fields: ${rejected.join(', ')}. Qubicl does not import mounts, privilege, lifecycle hooks, port publication, Compose, or capability claims.`);
  if ((document.image === undefined) === (document.build === undefined)) throw new Error('devcontainer.json must specify exactly one of image or build.');
  if (document.workspaceFolder !== undefined && (typeof document.workspaceFolder !== 'string' || !document.workspaceFolder.startsWith('/home/qubicl'))) {
    throw new Error('workspaceFolder, when present, must be beneath /home/qubicl. Qubicl does not import arbitrary host mounts.');
  }
  return { root, path, document };
}

function environment(document: DevcontainerDocument): Record<string, string> | undefined {
  const combined: Record<string, string> = {};
  for (const candidate of [document.containerEnv, document.remoteEnv]) {
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('containerEnv and remoteEnv must be string maps.');
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value !== 'string' || value.includes('${')) throw new Error(`Environment ${key} must be a literal string; devcontainer variable substitution is not imported.`);
      combined[key] = value;
    }
  }
  return Object.keys(combined).length ? combined : undefined;
}

async function imageReference(root: string, document: DevcontainerDocument, requestedTag: string | undefined): Promise<string> {
  if (typeof document.image === 'string' && document.image) return document.image;
  if (!document.build || typeof document.build !== 'object' || Array.isArray(document.build)) throw new Error('build must be an object.');
  const build = document.build as Record<string, unknown>;
  const allowed = new Set(['dockerfile', 'context', 'args', 'target']);
  const unsupported = Object.keys(build).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported devcontainer build fields: ${unsupported.join(', ')}.`);
  const context = await realpath(resolve(root, typeof build.context === 'string' ? build.context : '.'));
  const dockerfile = await realpath(resolve(root, typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile'));
  if (relative(root, context).startsWith('..') || relative(root, dockerfile).startsWith('..') || isAbsolute(relative(root, context))) throw new Error('Build context and Dockerfile must stay inside the imported directory.');
  const tag = requestedTag ?? `qubicl/devcontainer-${Date.now()}:local`;
  const command = ['build', '--tag', tag, '--file', dockerfile];
  if (build.target !== undefined) {
    if (typeof build.target !== 'string') throw new Error('build.target must be a string.');
    command.push('--target', build.target);
  }
  if (build.args !== undefined) {
    if (!build.args || typeof build.args !== 'object' || Array.isArray(build.args)) throw new Error('build.args must be a string map.');
    for (const [key, value] of Object.entries(build.args)) {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== 'string') throw new Error('build.args must use uppercase names and literal string values.');
      command.push('--build-arg', `${key}=${value}`);
    }
  }
  command.push(context);
  await docker(command, { inherit: true });
  return tag;
}

export async function devcontainerCommand(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0];
  if (action !== 'inspect' && action !== 'import') throw new Error('Devcontainer action must be inspect or import.');
  const directory = args.positionals[1];
  if (!directory) throw new Error('Missing devcontainer directory.');
  const loaded = await loadDocument(directory);
  if (action === 'inspect') {
    console.log(JSON.stringify({ path: loaded.path, image: loaded.document.image, build: loaded.document.build, environment: environment(loaded.document), rejectedFields: REJECTED }, null, 2));
    return;
  }
  const name = args.positionals[2];
  if (!name) throw new Error('Missing new computer name.');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const host = await validateDocker();
    const reference = await imageReference(loaded.root, loaded.document, stringOption(args, 'tag'));
    const acquired = await acquireCustomImage(reference, { offline: flag(args, 'offline'), platform: host.platform });
    const recommendation = IMAGE_CATALOG.presets[acquired.manifest.compatibility];
    const defaults = ComputerDefaultsSchema.parse({
      preset: 'custom', compatibility: acquired.manifest.compatibility, image: acquired.identity,
      capabilityContractVersion: 1, capabilities: acquired.manifest.capabilities,
      cpus: recommendation.recommendedCpus, memory: recommendation.recommendedMemory,
    });
    const computer: ComputerConfig = addConfiguredComputer(state, name, defaults);
    computer.environment = environment(loaded.document);
    const start = !flag(args, 'no-start');
    await ensureRuntimeImages(state, [computer], flag(args, 'offline'));
    await executeStateTransaction(paths, createStateTransaction('create', state, {
      activeSources: { [computer.id]: 'create' }, runtime: { startIds: start ? [computer.id] : [] },
    }));
    if (start) await synchronizeStartedSkillPolicies(state, [computer]);
    console.log(`Imported ${loaded.path} as ${computer.name}${start ? ' and started it' : ' (stopped)'}. The image passed Qubicl capability-manifest validation; host mounts, hooks, privileges, forwarded ports, and feature claims were not imported.`);
  });
}
