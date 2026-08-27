import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

test('distributable bundles include project and dependency licenses', async () => {
  const projectLicense = await readFile(join(root, 'LICENSE'), 'utf8');
  const locations = [
    join(root, 'packages/cli/dist/LICENSE'),
    join(root, 'packages/cli/dist/assets/gateway/LICENSE'),
    join(root, 'packages/cli/dist/assets/computer/LICENSE'),
  ];
  for (const location of locations) assert.equal(await readFile(location, 'utf8'), projectLicense);

  const cliNotices = await readFile(join(root, 'packages/cli/dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const dependency of ['@modelcontextprotocol/core@', 'yaml@', 'zod@']) assert.match(cliNotices, new RegExp(dependency.replace('@', '\\@')));
  assert.match(await readFile(join(root, 'packages/cli/dist/assets/gateway/THIRD_PARTY_NOTICES.txt'), 'utf8'), /zod@/);
  assert.match(await readFile(join(root, 'packages/cli/dist/assets/computer/THIRD_PARTY_NOTICES.txt'), 'utf8'), /@modelcontextprotocol\/server@/);
});

test('initial package publishing is explicit and guarded', async () => {
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    license?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(workspace.license, 'Apache-2.0');
  assert.equal(workspace.packageManager, 'npm@10.9.3');
  assert.equal(workspace.devDependencies?.oxlint, '1.79.0');
  assert.match(workspace.scripts?.['lint:source'] ?? '', /oxlint/);
  assert.match(workspace.scripts?.test ?? '', /test-coverage-lines=75/);
  assert.match(workspace.scripts?.['check:release'] ?? '', /scan:secrets/);
  assert.match(workspace.scripts?.['release:check'] ?? '', /public:check/);

  const manifest = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    private?: boolean;
    author?: string;
    license?: string;
    engines?: { node?: string };
    files?: string[];
    publishConfig?: { access?: string; registry?: string; tag?: string };
    scripts?: { prepublishOnly?: string };
  };
  assert.equal(manifest.name, 'qubicl-cli');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.author, 'Qubicl contributors');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.engines?.node, '^22.14.0 || ^24.0.0');
  assert.ok(manifest.files?.includes('dist/THIRD_PARTY_NOTICES.txt'));
  assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/', tag: 'latest' });
  assert.equal(manifest.scripts?.prepublishOnly, 'node ../../scripts/guard-publish.mjs');

  const publishGuard = await readFile(join(root, 'scripts/guard-publish.mjs'), 'utf8');
  assert.match(publishGuard, /QUBICL_ALLOW_NPM_PUBLISH/);
  assert.match(publishGuard, /approval !== version/);
  assert.match(publishGuard, /npm_config_tag/);
  assert.match(publishGuard, /requestedTag !== expectedTag/);
  assert.match(publishGuard, /npm_config_provenance/);
  assert.match(publishGuard, /requestedProvenance/);

  const candidateBuilder = await readFile(join(root, 'scripts/build-local-candidates.mjs'), 'utf8');
  assert.match(candidateBuilder, /release', 'candidates'/);
  assert.match(candidateBuilder, /const args = \[\s*'buildx', 'build'/);
  assert.match(candidateBuilder, /await run\('docker', args, \{ env:/);
  assert.match(candidateBuilder, /'trivy'/);
  assert.match(candidateBuilder, /trivy-summary\.json/);
  assert.match(candidateBuilder, /inspectOciEfficiencyArchives/);
  assert.match(candidateBuilder, /OCI_EFFICIENCY_REPORT_NAME/);
  assert.match(candidateBuilder, /vulnerability-applicability\.json/);
  assert.match(candidateBuilder, /verify-candidate\.mjs/);
  assert.match(candidateBuilder, /'bundle', 'create', bundle, 'HEAD'/);
  assert.match(candidateBuilder, /'clone', '--quiet', '--no-checkout', bundle, sourceRoot/);
  assert.match(candidateBuilder, /'checkout', '--quiet', '--detach', revision/);
  assert.match(candidateBuilder, /Isolated source archive does not reproduce the reviewed commit bytes/);
  assert.match(candidateBuilder, /Preserved failed candidate staging at/);
  assert.doesNotMatch(candidateBuilder, /Exact candidate source/);
  assert.doesNotMatch(candidateBuilder, /npm', \['publish/);
  assert.doesNotMatch(candidateBuilder, /docker', \['push/);
  assert.doesNotMatch(candidateBuilder, /gh', \['release/);

  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(rootManifest.scripts?.['candidate:preview'], 'node scripts/build-local-candidates.mjs --preview');
  assert.equal(rootManifest.scripts?.['candidate:release'], 'node scripts/build-local-candidates.mjs --initial');
  assert.equal(rootManifest.scripts?.['candidate:resume'], 'node scripts/resume-candidate.mjs');
  assert.equal(rootManifest.scripts?.['release:publish'], 'node scripts/publish-candidate.mjs');
  assert.match(candidateBuilder, /releaseTier/);
  assert.match(candidateBuilder, /--preview requires a prerelease package version/);

  const acceptance = await readFile(join(root, 'scripts/acceptance-evidence.mjs'), 'utf8');
  assert.match(acceptance, /Acceptance schemaVersion must be 3 or 4/);
  assert.match(acceptance, /schemaVersion 4 is required for v0\.2/);
  assert.match(acceptance, /remote-access-v1\.json|REMOTE_ACCESS_REQUIREMENTS_NAME/);
  assert.match(acceptance, /remoteGateway/);
  const remoteAccessRequirements = JSON.parse(await readFile(join(root, 'conformance/remote-access-v1.json'), 'utf8')) as {
    schemaVersion?: number;
    protocol?: string;
    profiles?: Array<{ platformId?: string }>;
    requiredSurfaces?: string[];
  };
  assert.equal(remoteAccessRequirements.schemaVersion, 1);
  assert.equal(remoteAccessRequirements.protocol, 'direct-tls-v1');
  assert.deepEqual(remoteAccessRequirements.profiles?.map(({ platformId }) => platformId), [
    'linux-x64',
    'macos-apple-silicon',
    'windows-wsl2-x64',
  ]);
  assert.ok(remoteAccessRequirements.requiredSurfaces?.includes('preview-websocket'));
  assert.match(acceptance, /releaseSetSha256/);
  const publisher = await readFile(join(root, 'scripts/publish-candidate.mjs'), 'utf8');
  assert.match(publisher, /v0\.2 or later publication require a signed release set/);
  assert.match(publisher, /requiresClientConformance\(candidate\.version\)/);
  const candidateEvidence = await readFile(join(root, 'scripts/candidate-evidence.mjs'), 'utf8');
  assert.match(candidateEvidence, /Trivy binding schemaVersion.*required for v0\.2 and later candidates/);
  assert.match(candidateEvidence, /v0\.2 and later image candidates require exact OCI efficiency evidence/);
  assert.match(candidateEvidence, /oci-efficiency\.json does not match the exact candidate OCI archives/);

});

test('vulnerability applicability inventory is machine-validated and empty by default', async () => {
  const module = await import(pathToFileURL(join(root, 'scripts/candidate-evidence.mjs')).href);
  const document = JSON.parse(await readFile(join(root, 'security/vulnerability-applicability.json'), 'utf8'));
  const statements = module.parseVulnerabilityApplicability(document) as Array<Record<string, unknown>>;
  assert.deepEqual(statements, []);
});

test('repository does not define GitHub Actions workflows', async () => {
  let workflows: string[] = [];
  try {
    workflows = (await readdir(join(root, '.github/workflows')))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.deepEqual(workflows, []);
});

test('routine dependency review stays manual and local', async () => {
  await assert.rejects(
    readFile(join(root, '.github/dependabot.yml'), 'utf8'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
  const development = await readFile(join(root, 'docs/development.md'), 'utf8');
  assert.match(development, /Dependency review is manual and local/u);
  assert.match(development, /Hosted security\s+alerts are a separate repository setting/u);
});

test('brand marks are deterministic vector assets with light and dark README variants', async () => {
  const names = [
    'qubicl-mark.svg',
    'qubicl-mark-dark.svg',
    'qubicl-mark-mono.svg',
    'qubicl-logo.svg',
    'qubicl-logo-dark.svg',
  ];
  for (const name of names) {
    const asset = await readFile(join(root, 'assets', 'brand', name), 'utf8');
    assert.match(asset, /^<svg[^>]+viewBox=/);
    assert.match(asset, /<title[^>]*>/);
    assert.match(asset, /<path /);
    assert.doesNotMatch(asset, /<(?:text|image|script|foreignObject)\b|(?:href|src)\s*=/);
  }
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(readme, /prefers-color-scheme: dark/);
  assert.match(readme, /assets\/brand\/qubicl-mark\.svg/);
  assert.match(readme, /assets\/brand\/qubicl-mark-dark\.svg/);

  const branding = await readFile(join(root, 'BRANDING.md'), 'utf8');
  const brandLicense = await readFile(join(root, 'assets', 'brand', 'LICENSE-CC-BY-4.0.md'), 'utf8');
  assert.match(branding, /assets\/brand\/\*\.svg/);
  assert.match(branding, /assets\/brand\/exploration\/\*\*\/\*\.png/);
  assert.match(branding, /copy, display, share, modify, redistribute/);
  assert.match(branding, /including commercially/);
  assert.match(branding, /unofficial fork/);
  assert.match(branding, /does not\s+automatically apply to screenshots/);
  assert.match(brandLicense, /SPDX-License-Identifier: CC-BY-4\.0/);
  assert.match(brandLicense, /Qubicl logo by EldanRing, licensed under CC BY 4\.0/);
  assert.match(readme, /source code and documentation are Apache-2\.0/);
  assert.match(readme, /official brand artwork are CC BY 4\.0/);
  assert.match(readme, /\[BRANDING\.md\]\(BRANDING\.md\)/);
});

test('public issue intake disables blank issues and routes security reports privately', async () => {
  const config = await readFile(join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');
  assert.match(config, /^blank_issues_enabled: false$/m);
  assert.match(config, /\/security\/policy/);
  assert.match(config, /never post credentials or sensitive diagnostics/i);
});

test('native archives include the exact embedded Node runtime license', async () => {
  const binaryBuilder = await readFile(join(root, 'scripts/build-binary.mjs'), 'utf8');
  assert.match(binaryBuilder, /copyFile\(await nodeLicense\(\), join\(output, 'NODE_LICENSE'\)\)/);
  assert.match(binaryBuilder, /QUBICL_NODE_LICENSE/);
});

test('container bases are pinned by digest', async () => {
  for (const dockerfile of ['images/gateway/Dockerfile', 'images/computer/Dockerfile']) {
    const contents = await readFile(join(root, dockerfile), 'utf8');
    assert.match(contents, /^FROM [^\s]+@sha256:[a-f0-9]{64}(?: AS [a-z0-9-]+)?$/m);
    for (const label of ['source', 'version', 'revision', 'created']) assert.match(contents, new RegExp(`org\\.opencontainers\\.image\\.${label}=`));
  }

  const gateway = await readFile(join(root, 'images/gateway/Dockerfile'), 'utf8');
  assert.match(gateway, /apk upgrade --no-cache libcrypto3 libssl3/);
  assert.match(gateway, /\/usr\/local\/lib\/node_modules\/npm/);

  const computer = await readFile(join(root, 'images/computer/Dockerfile'), 'utf8');
  assert.match(computer, /apt-get upgrade -y/);
  assert.match(computer, /apt-get download novnc/);
  assert.doesNotMatch(computer, /^\s+novnc \\/m);
  assert.match(computer, /brace-expansion@5\.0\.9/);
  assert.match(computer, /ip-address@10\.3\.1/);
  assert.match(computer, /tar@7\.5\.21/);
  for (const instruction of computer.split(/\n(?=RUN )/u)) {
    if (instruction.includes('apt-get install')) {
      assert.match(instruction, /apt-get install -y --no-install-recommends/);
      assert.match(instruction, /rm -rf [^\n]*\/var\/lib\/apt\/lists\/\*/);
    }
    if (instruction.includes('/pip install')) {
      assert.match(instruction, /\/pip install --no-cache-dir/);
      assert.match(instruction, /find [^\n]* -type d -name __pycache__ -prune -exec rm -rf/);
    }
  }
  assert.match(computer, /npm cache clean --force/);
  for (const name of ['curl', 'fd-find', 'gh', 'jq', 'ripgrep', 'tree', 'unzip', 'wget', 'zip']) {
    assert.match(computer, new RegExp(`^\\s+${name} \\\\$`, 'm'));
  }
  assert.match(computer, /ln -s \/usr\/bin\/fdfind \/usr\/local\/bin\/fd/);
  for (const name of ['poppler-utils', 'tesseract-ocr', 'tesseract-ocr-eng']) {
    assert.match(computer, new RegExp(`^\\s+${name} \\\\$`, 'm'));
  }
  for (const name of ['nano', 'openssh-client', 'openssh-server', 'python3-pip', 'vim']) {
    assert.match(computer, new RegExp(`^\\s+${name} \\\\$`, 'm'));
  }
  assert.match(computer, /^\s+iproute2 \\/m);
  assert.match(computer, /^\s+netcat-openbsd \\/m);
  assert.match(computer, /rm -f \/etc\/ssh\/ssh_host_\*_key\*/);
  assert.match(computer, /--no-first-run --no-default-browser-check/);
  assert.doesNotMatch(computer, /--no-sandbox|--disable-dev-shm-usage/);
  assert.match(computer, /rm -f \/etc\/chromium\.d\/dev-shm/);
  assert.match(computer, /libreoffice-registrymodifications\.xcu/);
  for (const target of ['file-system', 'browser', 'computer', 'workstation']) assert.match(computer, new RegExp(` AS ${target}$`, 'm'));
  assert.doesNotMatch(computer, /^\s+xfce4\s*\\$/m);
  assert.doesNotMatch(computer, /^\s+(?:atril|ristretto)\s*\\$/m);
  const minimalStage = computer.slice(0, computer.indexOf('FROM filesystem-base AS display-browser-base'));
  assert.doesNotMatch(minimalStage, /playwright-core|qubicl-chromium/);
  const browserStage = computer.slice(computer.indexOf('FROM document-inspection-base AS browser-runtime'), computer.indexOf('FROM document-inspection-base AS computer-runtime'));
  assert.match(browserStage, /openbox/);
  assert.doesNotMatch(browserStage, /xfce4|thunar|mousepad/);
  for (const label of ['contract-version', 'preset', 'compatibility', 'capabilities', 'manifest-sha256']) assert.match(computer, new RegExp(`dev\\.qubicl\\.${label}=`));
});

test('web extraction dependencies are fully pinned, licensed, and included in image evidence', async () => {
  const requirements = (await readFile(join(root, 'images/computer/web-requirements.txt'), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(requirements.every((line) => /^[A-Za-z0-9_.-]+==[^=\s]+$/.test(line)));
  assert.equal(new Set(requirements.map((line) => line.split('==')[0]!.toLowerCase().replaceAll('_', '-'))).size, requirements.length);
  for (const dependency of ['trafilatura==2.2.0', 'readability-lxml==0.8.4.1', 'courlan==1.4.0', 'jusText==3.0.2']) {
    assert.ok(requirements.includes(dependency), `${dependency} must be pinned in the web image closure`);
  }

  const notices = await readFile(join(root, 'images/computer/WEB_THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const requirement of requirements) {
    const [name, version] = requirement.split('==');
    const escapedName = name!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedVersion = version!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(notices, new RegExp(`^${escapedName} ${escapedVersion} — `, 'm'));
  }

  const dockerfile = await readFile(join(root, 'images/computer/Dockerfile'), 'utf8');
  assert.match(dockerfile, /web-requirements\.txt/);
  assert.match(dockerfile, /web-python-licenses/);
  const candidateBuilder = await readFile(join(root, 'scripts/build-local-candidates.mjs'), 'utf8');
  assert.match(candidateBuilder, /--sbom=true/);
  assert.match(candidateBuilder, /'trivy'/);
});

test('workstation starts LibreOffice without the first-run tip prompt', async () => {
  const configuration = await readFile(join(root, 'images/computer/libreoffice-registrymodifications.xcu'), 'utf8');
  assert.match(configuration, /oor:name="ShowTipOfTheDay"[\s\S]*?<value>false<\/value>/);

  const builder = await readFile(join(root, 'scripts/build.mjs'), 'utf8');
  assert.match(builder, /images\/computer\/libreoffice-registrymodifications\.xcu/);
});

test('ordinary computer startup never recursively rewrites a durable home', async () => {
  const entrypoint = await readFile(join(root, 'images/computer/entrypoint.sh'), 'utf8');
  assert.doesNotMatch(entrypoint, /chown\s+-[^\n]*R|chown\s+--recursive/);
  assert.match(entrypoint, /qubicl repair ownership/);

  const commands = await readFile(join(root, 'packages/cli/src/commands.ts'), 'utf8');
  assert.match(commands, /repair ownership <name>/);
  assert.match(commands, /ownership-repair\.json/);
});

test('viewer images isolate raw VNC behind authenticated dedicated-user Unix relays', async () => {
  const dockerfile = await readFile(join(root, 'images/computer/Dockerfile'), 'utf8');
  const entrypoint = await readFile(join(root, 'images/computer/entrypoint.sh'), 'utf8');
  const relay = await readFile(join(root, 'images/computer/x11vnc-relay.sh'), 'utf8');
  const authentication = await readFile(join(root, 'images/computer/qubicl_viewer_auth.py'), 'utf8');
  const builder = await readFile(join(root, 'scripts/build.mjs'), 'utf8');

  assert.match(dockerfile, /^\s+socat \\$/m);
  assert.match(dockerfile, /useradd --system --gid qubicl-viewer/);
  assert.match(dockerfile, /COPY --chown=root:root qubicl_viewer_auth\.py \/usr\/lib\/python3\/dist-packages\/qubicl_viewer_auth\.py/);
  assert.doesNotMatch(dockerfile, /COPY[^\n]*qubicl_viewer_auth\.py[^\n]*\/opt\/qubicl/);
  assert.match(dockerfile, /python3 -I -c 'import qubicl_viewer_auth;/);
  assert.match(dockerfile, /runuser -u qubicl -- test ! -w \/usr\/lib\/python3\/dist-packages\/qubicl_viewer_auth\.py/);
  assert.match(dockerfile, /dev\.qubicl\.viewer-authentication="header-v1"/);
  assert.match(dockerfile, /QUBICL_IMAGE_VIEWER_AUTHENTICATION=header-v1/);
  assert.match(entrypoint, /UNIX-LISTEN:\/run\/qubicl-viewer\/sockets\/view\.sock,fork,mode=0600/);
  assert.match(entrypoint, /--unix-target=\/run\/qubicl-viewer\/sockets\/control\.sock/);
  assert.match(entrypoint, /--web-auth/);
  assert.match(entrypoint, /runuser -u qubicl-viewer -- env -i/);
  assert.match(entrypoint, /install -d -m 0750 -o root -g qubicl-viewer \/run\/qubicl-viewer/);
  assert.match(entrypoint, /baked_viewer_authentication="\$\{QUBICL_IMAGE_VIEWER_AUTHENTICATION:-legacy\}"/);
  assert.match(entrypoint, /runtime_viewer_authentication="\$\{QUBICL_VIEWER_AUTHENTICATION:-\}"/);
  assert.match(entrypoint, /viewer_key_handoff="\$\{QUBICL_VIEWER_KEY:-\}"\s+unset QUBICL_VIEWER_AUTHENTICATION QUBICL_VIEWER_KEY/);
  assert.ok(entrypoint.indexOf('unset QUBICL_VIEWER_AUTHENTICATION QUBICL_VIEWER_KEY') < entrypoint.indexOf('exec node /opt/qubicl/control.mjs'));
  assert.match(entrypoint, /--auth-source=\/run\/qubicl-viewer\/key/);
  assert.match(entrypoint, /\/usr\/bin\/python3 -I \/usr\/bin\/websockify/);
  assert.match(entrypoint, /\(umask 077; printf '[^']*' "\$viewer_key" >\/run\/qubicl-viewer\/key\)/);
  assert.doesNotMatch(entrypoint, /^umask 077$/m);
  assert.doesNotMatch(entrypoint, /\/home\/[^\n]*(?:viewer|key)|(?:viewer|key)[^\n]*\/home\//i);
  assert.doesNotMatch(entrypoint, /--auth-source=.*(?:QUBICL_VIEWER_KEY|viewer_key_handoff)/);
  assert.doesNotMatch(entrypoint, /localhost:590[01]|-rfbport 590[01]/);
  assert.match(relay, /-inetd/);
  assert.match(relay, /-rfbport 0/);
  assert.doesNotMatch(relay, /QUBICL_VIEWER_KEY|590[01]/);
  assert.match(authentication, /X-Qubicl-Viewer-Key/);
  assert.match(authentication, /KEY_PATTERN\.fullmatch\(received\)/);
  assert.match(authentication, /compare_digest/);
  assert.doesNotMatch(authentication, /response_msg=.*(?:key|header|credential)/i);
  assert.doesNotMatch(authentication, /print\s*\(/);
  assert.match(builder, /images\/computer\/qubicl_viewer_auth\.py/);
  assert.match(builder, /images\/computer\/x11vnc-relay\.sh/);
});

test('performance checks are local and dependency-free', async () => {
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(workspace.scripts?.performance, 'node scripts/performance.mjs');
  const harness = await readFile(join(root, 'scripts/performance.mjs'), 'utf8');
  assert.doesNotMatch(harness, /https?:\/\/(?!127\.0\.0\.1(?::|\/))/);
  assert.match(harness, /Full-topology self-test/);
  assert.match(harness, /QUBICL_HOME/);
  assert.doesNotMatch(harness, /npm\s+publish|docker\s+push|gh\s+release/);
});
