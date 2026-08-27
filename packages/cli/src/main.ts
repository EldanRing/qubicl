#!/usr/bin/env node
import { parseArgs } from './args.js';
import { execute } from './commands.js';
import { recordCliAudit } from './audit-log.js';

const [rawCommand, ...rest] = process.argv.slice(2);
const command = rawCommand === '--help' || rawCommand === '-h'
  ? 'help'
  : rawCommand === '--version' || rawCommand === '-V'
    ? 'version'
    : rawCommand;

const interrupt = (): never => {
  process.stderr.write('\nqubicl: interrupted. Rerun the command; any pending transaction will be recovered safely.\n');
  process.exit(130);
};

process.once('SIGINT', interrupt);
async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs> | undefined;
  try {
    args = parseArgs(rest);
    await execute(command, args);
    await recordCliAudit(command, 'ok', args.positionals);
  } catch (error) {
    await recordCliAudit(command, 'error', args?.positionals);
    console.error(`qubicl: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}

void main();
