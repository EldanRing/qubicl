import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectBundledPackages } from './bundle-evidence.mjs';

const licenseFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

export async function generateThirdPartyNotices(root, metafiles) {
  const packages = await collectBundledPackages(root, metafiles.map((metafile) => ({ metafile })));
  return generateThirdPartyNoticesFromPackages(packages);
}

export async function generateThirdPartyNoticesFromPackages(packages) {
  const sections = [];
  for (const dependency of packages) {
    const key = dependency.key;
    const names = (await readdir(dependency.directory)).filter((name) => licenseFile.test(name)).sort();
    if (!names.length) throw new Error(`Bundled dependency ${key} has no license or notice file.`);
    const declaredLicense = typeof dependency.manifest.license === 'string'
      ? dependency.manifest.license
      : JSON.stringify(dependency.manifest.license ?? 'unspecified');
    const texts = await Promise.all(names.map(async (name) => {
      const contents = (await readFile(join(dependency.directory, name), 'utf8')).trim();
      return `--- ${name} ---\n${contents}`;
    }));
    sections.push(`${key}\nDeclared license: ${declaredLicense}\n\n${texts.join('\n\n')}`);
  }

  return [
    'Qubicl third-party notices',
    '',
    'This distribution contains the following bundled dependencies. Their license and notice texts are reproduced below.',
    '',
    sections.join(`\n\n${'='.repeat(80)}\n\n`),
    '',
  ].join('\n');
}
