import { createStagingIssuer } from './staging-issuer-sandbox';

try {
  const directory = process.env.AQUA_LOCAL_STAGING_ISSUER_DIR;
  let receipts;
  if (directory !== undefined) {
    if (process.env.NODE_ENV !== 'staging' || directory !== '/var/aqua-issuer') throw new Error('Invalid local issuer directory.');
    process.umask(0o077);
    const { LocalStagingIssuerReceipts } = await import('./local-staging-issuer-receipts');
    receipts = new LocalStagingIssuerReceipts(directory);
  }
  const app = createStagingIssuer(process.env.AQUA_ISSUER_KEY_ID ?? '', process.env.AQUA_ISSUER_SIGNING_KEY ?? '', receipts);
  await app.listen({ host: '127.0.0.1', port: 3005 });
  const close = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('Private staging issuer could not start.');
  process.exitCode = 1;
}
