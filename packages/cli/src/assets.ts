import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

/** Locate packaged CLI assets in both module and single-executable builds. */
export function packagedAssetsPath(): string {
  if (isSea()) return join(dirname(process.execPath), 'assets');
  return fileURLToPath(new URL('./assets/', import.meta.url));
}
