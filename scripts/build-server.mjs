import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['server/index.ts', 'server/auth-mail-worker.ts', 'server/migrate.ts', 'server/credit.ts', 'server/card.ts', 'server/card-operations-operator.ts', 'server/customer-access-operator.ts', 'server/rewards-operator.ts', 'server/reconcile-rewards.ts', 'server/operations-monitor.ts', 'server/staging-bootstrap.ts', 'server/card-worker.ts', 'server/card-ingress.ts', 'server/card-inbox-operator.ts', 'server/issuer-operator.ts', 'server/issuer-dispatcher.ts'],
  outdir: 'dist-server', bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'external', sourcemap: 'external', logLevel: 'info',
});
await mkdir('dist-server/migrations', { recursive: true });
await cp('server/migrations', 'dist-server/migrations', { recursive: true });
