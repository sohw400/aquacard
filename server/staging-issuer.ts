import { createStagingIssuer } from './staging-issuer-sandbox';

try {
  const app = createStagingIssuer(process.env.AQUA_ISSUER_KEY_ID ?? '', process.env.AQUA_ISSUER_SIGNING_KEY ?? '');
  await app.listen({ host: '127.0.0.1', port: 3005 });
  const close = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('Private staging issuer could not start.');
  process.exitCode = 1;
}
