import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The door's TLS identity: a key and a self-signed certificate made on this Mac, and the pin a phone checks it by. */
export interface DoorIdentity {
  key: string;
  cert: string;
  pin: string;
}

/** SHA-256 of a certificate (DER), base64url: what the pairing QR code carries, and the phone compares. */
export const certificatePin = (pem: string) => createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');

const DAY = 86_400_000;

/**
 * The door's identity, kept in `dir` (0700, the key 0600) and made the first time with macOS's own
 * openssl: a P-256 key and a certificate good for ten years. A new one means pairing phones again,
 * so it's made again only when it's missing, broken or about to run out.
 */
export async function doorIdentity(dir: string): Promise<DoorIdentity> {
  const keyFile = join(dir, 'door.key');
  const certFile = join(dir, 'door.crt');
  try {
    const [key, cert] = await Promise.all([readFile(keyFile, 'utf8'), readFile(certFile, 'utf8')]);
    const certificate = new X509Certificate(cert);
    if (Date.parse(certificate.validTo) > Date.now() + 30 * DAY && certificate.checkPrivateKey(createPrivateKey(key))) return { key, cert, pin: certificatePin(cert) };
  } catch {
    // not made yet, or unusable: made below
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const [newKey, newCert] = [`${keyFile}.new`, `${certFile}.new`];
  try {
    await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', newKey]);
    await chmod(newKey, 0o600);
    await run('openssl', ['req', '-new', '-x509', '-sha256', '-key', newKey, '-out', newCert, '-days', '3650', '-subj', '/CN=Nova']);
    await rename(newKey, keyFile);
    await rename(newCert, certFile);
  } finally {
    await Promise.all([rm(newKey, { force: true }), rm(newCert, { force: true })]);
  }
  const [key, cert] = await Promise.all([readFile(keyFile, 'utf8'), readFile(certFile, 'utf8')]);
  return { key, cert, pin: certificatePin(cert) };
}
