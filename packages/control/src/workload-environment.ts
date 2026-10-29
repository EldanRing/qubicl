import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workloadEnvironment } from './environments.js';

// A separate entry point keeps this CLI guard out of the controller bundle.
// Image startup consumes the entries with a NUL-delimited shell array.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, value] of Object.entries(workloadEnvironment(process.env))) {
    if (value !== undefined) process.stdout.write(`${name}=${value}\0`);
  }
}
