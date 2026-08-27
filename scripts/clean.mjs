import { rm } from 'node:fs/promises';

await Promise.all([
  rm(new URL('../dist-tests', import.meta.url), { recursive: true, force: true }),
  ...['core', 'gateway', 'control', 'cli'].map((name) =>
    rm(new URL(`../packages/${name}/dist`, import.meta.url), { recursive: true, force: true }),
  ),
]);
