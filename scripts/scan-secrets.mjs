import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.env.QUBICL_GITLEAKS ?? 'gitleaks';

if (process.argv.includes('--help')) {
  console.log(`Usage: npm run scan:secrets

Scan committed history and the current worktree with Gitleaks. Install the
locally verified Gitleaks version documented in docs/development.md, or set
QUBICL_GITLEAKS to an equivalent executable path.`);
  process.exit(0);
}

if (process.argv.length > 2) throw new Error(`Unknown option ${process.argv[2]}.`);

await run(['version']);
await run(['git', '--no-banner', '--no-color', '--redact=100', '--verbose', root]);
await run(['dir', '--no-banner', '--no-color', '--redact=100', '--verbose', root]);
console.log('Gitleaks found no secrets in committed history or the current worktree.');

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit' });
    child.once('error', (error) => reject(new Error(`Could not run ${executable}.`, { cause: error })));
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${executable} was terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`${executable} exited with code ${code}.`));
      else resolvePromise();
    });
  });
}
