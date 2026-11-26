import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only complete CA certificates may cross from the secret mount into the image. */
function validateCertificates(bytes) {
  const text = bytes.toString('utf8');
  const pem = /-----BEGIN CERTIFICATE-----\r?\n([a-zA-Z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----/g;
  let end = 0;
  for (const match of text.matchAll(pem)) {
    if (!/^[ \t\r\n]*$/.test(text.slice(end, match.index))) break;
    const base64 = match[1].replace(/[\r\n]/g, '');
    const der = Buffer.from(base64, 'base64');
    const cert = new X509Certificate(der);
    if (!cert.ca || !cert.raw.equals(der) || der.toString('base64') !== base64) {
      throw new Error('Expected an X.509 CA certificate in PEM format.');
    }
    end = match.index + match[0].length;
  }
  if (!end || !/^[ \t\r\n]*$/.test(text.slice(end))) throw new Error('Only CA certificate PEM blocks are allowed.');
}

export async function installRdsCa(source, digest, destination) {
  let bytes;
  try { bytes = await readFile(source); }
  catch (error) {
    if (error.code === 'ENOENT' && !digest) return;
    throw new Error('A pinned RDS CA digest requires the rds_ca build secret.');
  }
  if (!/^[a-f0-9]{64}$/i.test(digest ?? '') || createHash('sha256').update(bytes).digest('hex') !== digest.toLowerCase()) {
    throw new Error('The RDS CA bundle requires a matching RDS_CA_SHA256.');
  }
  validateCertificates(bytes);
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o444 });
  await chmod(destination, 0o444);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await installRdsCa('/run/secrets/rds_ca', process.env.RDS_CA_SHA256, '/trust/aqua/rds-ca.pem'); }
  catch {
    // A malformed secret must never appear in build logs.
    console.error('RDS trust installation failed. Check the CA-only PEM bundle and the pinned RDS_CA_SHA256.');
    process.exitCode = 1;
  }
}
