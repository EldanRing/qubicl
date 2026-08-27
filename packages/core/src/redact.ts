const secretKey = /^(?:token|internalKey|authorization|secret|password|.*(?:Key|Token|Secret|Password))$/i;
const bearerToken = /qubicl_[A-Za-z0-9_-]{32,}/g;
const qubiclSecretEnvironment = /^(QUBICL_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=/u;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    const environment = qubiclSecretEnvironment.exec(value);
    if (environment) return `${environment[1]}=[REDACTED]`;
    if (/^Bearer\s+/i.test(value)) return 'Bearer [REDACTED]';
    return value.replace(bearerToken, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, secretKey.test(key) ? '[REDACTED]' : redactSecrets(nested)]));
}
