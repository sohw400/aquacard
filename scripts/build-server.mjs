import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['server/index.ts', 'server/migrate.ts', 'server/credit.ts', 'server/card.ts'],
  outdir: 'dist-server', bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'external', sourcemap: 'external', logLevel: 'info',
});
await mkdir('dist-server/migrations', { recursive: true });
await cp('server/migrations', 'dist-server/migrations', { recursive: true });
