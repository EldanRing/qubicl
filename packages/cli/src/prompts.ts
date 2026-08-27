import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  CURATED_PRESETS,
  formatBytes,
  type DockerPlatform,
  type ImageCatalog,
  type Preset,
} from '@qubicl/core';

export interface SetupPrompt {
  write(message: string): void;
  question(message: string): Promise<string>;
  redraw?(message: string): void;
  close(): void;
}

export class SetupCancelledError extends Error {
  constructor() { super('Setup cancelled by the operator.'); }
}

export class SetupBackError extends Error {
  constructor() { super('Return to the previous setup step.'); }
}

export class ReadlineSetupPrompt implements SetupPrompt {
  private readonly readline: Interface;

  constructor(
    private readonly stream: NodeJS.WriteStream = stdout,
    private readonly redrawEnabled = Boolean(stream.isTTY),
  ) {
    this.readline = createInterface({ input: stdin, output: stream });
  }

  write(message: string): void {
    this.stream.write(`${message}\n`);
  }

  question(message: string): Promise<string> {
    return this.readline.question(message);
  }

  redraw(message: string): void {
    if (this.redrawEnabled) this.stream.write('\u001b[3J\u001b[2J\u001b[H');
    this.write(message);
  }

  close(): void {
    this.readline.close();
  }
}

export async function confirm(prompt: SetupPrompt, message: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await prompt.question(`${message} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    navigate(answer);
    if (!answer) return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    prompt.write('Enter y or n.');
  }
}

export async function choosePreset(
  prompt: SetupPrompt,
  current?: { preset?: Preset; customImage?: string },
): Promise<{ preset?: Preset; image?: string }> {
  const suffix = current ? ' (Enter keeps the current selection)' : '';
  for (;;) {
    const answer = (await prompt.question(`Choose 1-4 or a preset ID; enter 5 for a custom image${suffix} (or cancel): `)).trim();
    navigate(answer);
    if (!answer && current) return current.preset ? { preset: current.preset } : { image: current.customImage! };
    const index = Number(answer);
    const preset = Number.isInteger(index) && index >= 1 && index <= CURATED_PRESETS.length
      ? CURATED_PRESETS[index - 1]
      : CURATED_PRESETS.find((candidate) => candidate === answer);
    if (preset) return { preset };
    if (answer === '5' || answer === 'custom') {
      const image = (await prompt.question('Custom image reference (or back): ')).trim();
      if (image.toLowerCase() === 'back') continue;
      navigate(image);
      if (image) return { image };
    }
    prompt.write('Select file-system, browser, computer, workstation, or custom.');
  }
}

export async function questionWithDefault(prompt: SetupPrompt, message: string, fallback: string): Promise<string> {
  const answer = (await prompt.question(`${message} [${fallback}]: `)).trim();
  navigate(answer);
  return answer || fallback;
}

function navigate(answer: string): void {
  const normalized = answer.toLowerCase();
  if (normalized === 'cancel') throw new SetupCancelledError();
  if (normalized === 'back') throw new SetupBackError();
}

export function presetComparison(
  catalog: ImageCatalog,
  platform: DockerPlatform,
  width = stdout.columns || 100,
  verbose = false,
): string {
  const lines = ['Available presets:'];
  for (const [index, preset] of CURATED_PRESETS.entries()) {
    const entry = catalog.presets[preset];
    const image = entry.image.platforms[platform];
    const sizes = image?.downloadBytes === null && image?.expandedBytes === null && catalog.development
      ? 'image size not measured in source builds'
      : `download ${formatBytes(image?.downloadBytes ?? null)}; expanded ${formatBytes(image?.expandedBytes ?? null)}`;
    const details = verbose ? `; capabilities ${entry.capabilities.join(', ')}` : '';
    const summary = `${index + 1}. ${preset} — ${entry.purpose}; viewer ${entry.viewer ? 'yes' : 'no'}${details}; ${sizes}; recommended ${entry.recommendedCpus} CPU / ${entry.recommendedMemory}`;
    lines.push(...wrap(summary, Math.max(40, width), '   '));
  }
  lines.push(...wrap('5. custom — advanced compatible image (size and trust are operator-supplied)', Math.max(40, width), '   '));
  return lines.join('\n');
}

export function wrap(value: string, width: number, continuation = ''): string[] {
  if (value.length <= width) return [value];
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const prefix = lines.length ? continuation : '';
    if (line && prefix.length + line.length + 1 + word.length > width) {
      lines.push(`${lines.length ? continuation : ''}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`${lines.length ? continuation : ''}${line}`);
  return lines;
}
