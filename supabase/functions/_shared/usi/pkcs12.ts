// USI M2M credential: decrypts the ATO keystore's private key (2026-11-23, owner decision "option A").
// The keystore's protectedPrivateKey is a PKCS#8 EncryptedPrivateKeyInfo with the legacy PKCS#12 scheme
// pbeWithSHAAnd3-KeyTripleDES-CBC (OID 1.2.840.113549.1.12.1.3). Node opens it with createPrivateKey({ passphrase }); Deno's node:crypto
// does not ("invalid PKCS#8 private key"), so the key and IV are derived here (RFC 7292 Appendix B.2, SHA-1) and the data is decrypted
// with des-ede3-cbc, which Deno supports. The result is the plain PKCS#8 DER, opened with createPrivateKey. Nothing is logged.
// Runs in Deno and Node (scripts/test-document-extraction.ts compares the result with Node's own decryption of the kit keystore).
import { createDecipheriv, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const PBE_SHA1_3DES = "1.2.840.113549.1.12.1.3";

/** One DER element: tag, the start of its content and the end of the element. */
interface Der { tag: number; start: number; end: number }

function readDer(buf: Uint8Array, at: number): Der {
  const tag = buf[at];
  let len = buf[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    if (bytes < 1 || bytes > 4) throw new Error("Unsupported DER length");
    len = 0;
    for (let i = 0; i < bytes; i++) len = (len * 256) + buf[start + i];
    start += bytes;
  }
  const end = start + len;
  if (end > buf.length) throw new Error("Truncated DER element");
  return { tag, start, end };
}

function children(buf: Uint8Array, parent: Der): Der[] {
  const out: Der[] = [];
  for (let at = parent.start; at < parent.end;) { const d = readDer(buf, at); out.push(d); at = d.end; }
  return out;
}

function oidText(bytes: Uint8Array): string {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value * 128) + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join(".");
}

/** RFC 7292 Appendix B.2 key derivation with SHA-1 (u = 20, v = 64). id 1 = key material, 2 = IV. */
export function pkcs12Kdf(password: string, salt: Uint8Array, iterations: number, id: 1 | 2 | 3, size: number): Buffer {
  const u = 20, v = 64;
  // Password as a BMPString (UTF-16 big-endian) with two zero bytes at the end; an empty password is the empty string.
  const pw = Buffer.alloc(password.length ? (password.length + 1) * 2 : 0);
  for (let i = 0; i < password.length; i++) pw.writeUInt16BE(password.charCodeAt(i), i * 2);
  const fill = (src: Uint8Array) => {
    if (!src.length) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
    return out;
  };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(pw)]);
  const out: Buffer[] = [];
  for (let done = 0; done < size; done += u) {
    let A = createHash("sha1").update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = createHash("sha1").update(A).digest();
    out.push(A);
    if (done + u >= size) break;
    const B = fill(A);
    for (let j = 0; j < I.length; j += v) {
      // I_j = (I_j + B + 1) mod 2^(v*8), big-endian.
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, size);
}

/**
 * The plain PKCS#8 DER of a PKCS#12-3DES EncryptedPrivateKeyInfo. Any other scheme is refused with a clear message (the caller can
 * then try createPrivateKey with the passphrase, which Node handles for PBES2).
 */
export function decryptPkcs12ShroudedKey(encrypted: Uint8Array, password: string): Buffer {
  const top = readDer(encrypted, 0);
  if (top.tag !== 0x30) throw new Error("The keystore key is not an EncryptedPrivateKeyInfo");
  const [alg, data] = children(encrypted, top);
  if (!alg || !data || alg.tag !== 0x30 || data.tag !== 0x04) throw new Error("The keystore key is not an EncryptedPrivateKeyInfo");
  const [oid, params] = children(encrypted, alg);
  if (!oid || oid.tag !== 0x06) throw new Error("The keystore key has no algorithm");
  const scheme = oidText(encrypted.subarray(oid.start, oid.end));
  if (scheme !== PBE_SHA1_3DES) throw new Error(`Unsupported keystore key encryption (${scheme})`);
  const [saltEl, iterEl] = children(encrypted, params);
  if (!saltEl || !iterEl || saltEl.tag !== 0x04 || iterEl.tag !== 0x02) throw new Error("The keystore key parameters are not readable");
  const salt = encrypted.subarray(saltEl.start, saltEl.end);
  let iterations = 0;
  for (let i = iterEl.start; i < iterEl.end; i++) iterations = (iterations * 256) + encrypted[i];
  if (iterations < 1 || iterations > 10_000_000) throw new Error("The keystore key iteration count is not valid");
  const key = pkcs12Kdf(password, salt, iterations, 1, 24);
  const iv = pkcs12Kdf(password, salt, iterations, 2, 8);
  try {
    const decipher = createDecipheriv("des-ede3-cbc", key, iv);
    return Buffer.concat([decipher.update(encrypted.subarray(data.start, data.end)), decipher.final()]);
  } catch {
    throw new Error("The keystore password is not correct");
  }
}
