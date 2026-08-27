import { readFile } from 'node:fs/promises';
import { isToolName, type ComputerManifest, type ToolName } from '@qubicl/core';

interface PolicyDocument {
  version: 1;
  revision: string;
  tools: string[];
  catalogSkills: string[];
  skillRegistrySha256: string;
}

const LOCKED_TOOLS: ToolName[] = ['get_computer_status', 'acquire_lease', 'renew_lease', 'release_lease'];

export class RuntimePolicy {
  private tools: ToolName[];
  private catalogSkills: string[] = [];
  private skillRegistryDigest: string | undefined;
  private revision = 'manifest-default';

  constructor(private readonly manifest: ComputerManifest, private readonly path = process.env.QUBICL_POLICY_PATH) {
    this.tools = [...manifest.tools] as ToolName[];
  }

  async load(): Promise<{ changed: boolean; revision: string }> {
    if (!this.path) return { changed: false, revision: this.revision };
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as PolicyDocument;
    if (parsed.version !== 1 || typeof parsed.revision !== 'string' || !Array.isArray(parsed.tools) || !Array.isArray(parsed.catalogSkills)
      || (parsed.skillRegistrySha256 !== 'not-initialized' && !/^[a-f0-9]{64}$/u.test(parsed.skillRegistrySha256))) throw new Error('Qubicl runtime policy is invalid.');
    const maximum = new Set(this.manifest.tools);
    const tools = parsed.tools.map((name) => {
      if (!isToolName(name) || !maximum.has(name)) throw new Error(`Runtime policy tool ${name} is outside the image capability contract.`);
      return name;
    });
    if (new Set(tools).size !== tools.length) throw new Error('Runtime policy tools must be unique.');
    for (const required of LOCKED_TOOLS) if (!tools.includes(required)) throw new Error(`Runtime policy must retain ${required}.`);
    if (new Set(parsed.catalogSkills).size !== parsed.catalogSkills.length || parsed.catalogSkills.some((id) => !/^(?:(?:qubicl-core|imported)\/[a-z0-9][a-z0-9-]*|hermes-(?:default|optional)\/[a-z0-9][a-z0-9/-]*)$/.test(id))) throw new Error('Runtime operator skill policy is invalid.');
    const changed = this.revision !== parsed.revision;
    this.tools = tools;
    this.catalogSkills = [...parsed.catalogSkills];
    this.skillRegistryDigest = parsed.skillRegistrySha256;
    this.revision = parsed.revision;
    return { changed, revision: this.revision };
  }

  enabledTools(): ToolName[] { return [...this.tools]; }
  enabledCatalogSkills(): string[] { return [...this.catalogSkills]; }
  expectedSkillRegistrySha256(): string | undefined { return this.skillRegistryDigest; }
  isToolEnabled(name: ToolName): boolean { return this.tools.includes(name); }
  snapshot(): Record<string, unknown> { return { revision: this.revision, tools: this.enabledTools(), catalogSkills: this.enabledCatalogSkills(), ...(this.skillRegistryDigest ? { skillRegistrySha256: this.skillRegistryDigest } : {}) }; }
}
