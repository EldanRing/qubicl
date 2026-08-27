const role = process.env.QUBICL_RUNTIME_ROLE ?? 'control';
const runtime = role === 'control'
  ? await import('./server.js').then(({ controlServer, shutdownControlService }) => ({ server: controlServer, shutdown: shutdownControlService }))
  : role === 'egress'
    ? await import('./egress.js').then(({ createEgressServer, flushEgressAudit }) => ({ server: createEgressServer(), shutdown: flushEgressAudit }))
    : role === 'web'
      ? await import('./web.js').then(({ createWebServer }) => ({ server: createWebServer(), shutdown: async () => undefined }))
    : await import('./internal-runner.js').then(({ createInternalRunner }) => createInternalRunner());
const port = Number.parseInt(role === 'control' ? process.env.QUBICL_CONTROL_PORT ?? '3212' : role === 'executor' ? '3213' : role === 'session' ? '3214' : role === 'web' ? '3215' : '3128', 10);
const host = process.env.QUBICL_LISTEN_HOST ?? '0.0.0.0';
runtime.server.listen(port, host, () => {
  console.log(`Qubicl ${role} service listening on ${port}`);
});

const shutdown = (): void => {
  runtime.server.close(() => {
    void runtime.shutdown().then(() => process.exit(0), () => process.exit(1));
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
