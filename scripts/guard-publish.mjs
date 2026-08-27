const version = process.env.npm_package_version;
const approval = process.env.QUBICL_ALLOW_NPM_PUBLISH;
const requestedTag = process.env.npm_config_tag ?? 'latest';
const requestedProvenance = process.env.npm_config_provenance === 'true';
const expectedTag = version?.includes('-') ? 'dev' : 'latest';

if (!version || approval !== version || requestedTag !== expectedTag || requestedProvenance) {
  console.error(
    `Refusing to publish Qubicl. Set QUBICL_ALLOW_NPM_PUBLISH to the exact package version (${version ?? 'unknown'}), pass --tag ${expectedTag}, and keep npm provenance disabled for an explicitly approved local publication. The effective npm tag is ${requestedTag}; provenance is ${requestedProvenance ? 'enabled' : 'disabled'}.`,
  );
  process.exit(1);
}
