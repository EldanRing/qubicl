import { Gateway } from './server.js';
import { RouteStore } from './routes.js';
import { createEgressServer, flushEgressAudit } from '@qubicl/control/egress';
import { deriveInternalServiceKey } from '@qubicl/core';

const port = Number.parseInt(process.env.QUBICL_GATEWAY_PORT ?? '3211', 10);
const routesPath = process.env.QUBICL_ROUTES_PATH ?? '/runtime/routes.json';
const routeStore = new RouteStore(routesPath);
const gateway = new Gateway(routeStore);
const egress = createEgressServer({
  configurations: () => routeStore.list().map((route) => ({
    id: route.id,
    policy: route.networkPolicy ?? { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] },
    proxyKey: deriveInternalServiceKey(route.internalKey, 'egress-proxy'),
    brokerKey: deriveInternalServiceKey(route.internalKey, 'egress-broker'),
    brokerPath: `/runtime/brokers/${route.id}.json`,
    auditPath: `/audit/${route.id}.jsonl`,
  })),
});

await gateway.start(port);
await new Promise<void>((resolve, reject) => {
  egress.once('error', reject);
  egress.listen(3128, '0.0.0.0', () => {
    egress.off('error', reject);
    resolve();
  });
});
console.log(`Qubicl gateway listening on ${port}; shared egress broker listening on 3128`);

const shutdown = (): void => {
  void Promise.all([
    gateway.close(),
    new Promise<void>((resolve) => egress.close(() => resolve())),
  ]).then(() => flushEgressAudit()).finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
