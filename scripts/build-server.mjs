import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['server/index.ts', 'server/auth-mail-worker.ts', 'server/migrate.ts', 'server/credit.ts', 'server/card.ts', 'server/card-operations-operator.ts', 'server/customer-access-operator.ts', 'server/rewards-operator.ts', 'server/reserve-accrual-worker.ts', 'server/reconcile-rewards.ts', 'server/reconcile-issuer-statement.ts', 'server/reconcile-bank-settlement.ts', 'server/funding-operator.ts', 'server/card-application-provider.ts', 'server/auth-mail-feedback-operator.ts', 'server/settlement-case-operator.ts', 'server/authorization-simulator.ts', 'server/normalize-settlement-refs.ts', 'server/operations-monitor.ts', 'server/staging-bootstrap.ts', 'server/staging-issuer.ts', 'server/card-worker.ts', 'server/card-ingress.ts', 'server/card-inbox-operator.ts', 'server/issuer-operator.ts', 'server/issuer-dispatcher.ts'],
  outdir: 'dist-server', bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'external', sourcemap: 'external', logLevel: 'info',
});
await mkdir('dist-server/migrations', { recursive: true });
await cp('server/migrations', 'dist-server/migrations', { recursive: true });
