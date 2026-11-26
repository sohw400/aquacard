import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { installRdsCa } from '../docker/install-rds-ca.mjs';

// Self-signed end-entity certificate. The test never needs its private key.
const leaf = `-----BEGIN CERTIFICATE-----
MIIBkjCCATigAwIBAgIUHBxtuiASuDdFgnhFHKCOG6jQ68YwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVTG9jYWwgYnVpbGQgdGVzdCBsZWFmMB4XDTI2MTEyNjA1MTcw
MVoXDTM2MTEyMzA1MTcwMVowIDEeMBwGA1UEAwwVTG9jYWwgYnVpbGQgdGVzdCBs
ZWFmMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhGE8jT7HZIP9uViW2ORtNxdB
/OU6J/T3a8IyvaFvBkeKxWhgJ/bXvVmjULeBOl6ihJ4T/Sk4f9wXDZOYVAojFaNQ
ME4wHQYDVR0OBBYEFHv7DlhbyFG8isw0LxHbDt0G6mMwMB8GA1UdIwQYMBaAFHv7
DlhbyFG8isw0LxHbDt0G6mMwMAwGA1UdEwEB/wQCMAAwCgYIKoZIzj0EAwIDSAAw
RQIgREp/UVGMVTbW1K1Rows5jZcruHpSWdFFcOYeljqdSXgCIQCasHBdITjm08gF
DDbQNiP9DE092umNhEnT+/kLNfEnKA==
-----END CERTIFICATE-----`;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aqua-trust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { source: join(dir, 'secret'), destination: join(dir, 'trust', 'rds-ca.pem') };
}

test('a default build installs no CA, and both the mounted bundle and pin are required when enabled', async t => {
  const { source, destination } = await fixture(t);
  await installRdsCa(source, undefined, destination);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await assert.rejects(installRdsCa(source, digest('missing'), destination), /build secret/);
  await writeFile(source, rootCertificates[0]);
  for (const pin of [undefined, '', 'invalid', digest('different bytes')]) {
    await assert.rejects(installRdsCa(source, pin, destination), /RDS_CA_SHA256/);
  }
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('a verified CA rotation bundle is installed byte-for-byte and read-only', async t => {
  const { source, destination } = await fixture(t);
  const bundle = rootCertificates.slice(0, 2).join('\n\n').replaceAll('\n', '\r\n');
  await writeFile(source, bundle);
  await installRdsCa(source, digest(bundle), destination);
  assert.equal(await readFile(destination, 'utf8'), bundle);
  assert.equal((await stat(destination)).mode & 0o777, 0o444);
});

test('a matching pin cannot admit keys, leaves, malformed PEM, or trailing bytes inside a certificate', async t => {
  const { source, destination } = await fixture(t);
  const ca = rootCertificates[0];
  const withExtraBytes = Buffer.concat([new X509Certificate(ca).raw, Buffer.from('extra')]).toString('base64');
  for (const invalid of [
    '', '   ', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
    leaf, ca + '\n' + leaf, 'unrelated\n' + ca, ca + '\nend',
    ca + '\n-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----',
    '-----BEGIN CERTIFICATE-----\n' + withExtraBytes + '\n-----END CERTIFICATE-----',
  ]) {
    await writeFile(source, invalid);
    await assert.rejects(installRdsCa(source, digest(invalid), destination));
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  }
});
