/**
 * lan-cert.js - Phone full mode's TLS certificate: made on this machine, kept in the runtime dir, remade when it stops fitting.
 *
 * `AGENT_OFFICE_LAN=full` (server/lan.js, docs/reference.md › Phone mode)
 * serves the office to a phone over HTTPS on the Wi-Fi. No public CA will
 * sign a certificate for 192.168.x.y, so the office signs its own:
 *
 *   key    EC P-256, in $AGENT_OFFICE_HOME/lan-key.pem, mode 0600, read back
 *          only through the same trust checks the token file gets (a regular
 *          file, not a symlink, owned by this user, no group / other bits)
 *   cert   X.509 v3, self-signed with ECDSA-SHA256, in lan-cert.pem. Its one
 *          name is the LAN IP as a subjectAltName iPAddress (browsers ignore
 *          the common name). CA:FALSE and serverAuth only, so if the owner
 *          ever installs it on the phone as trusted, the key that sits in
 *          this directory can vouch for this one address and nothing else —
 *          it can never sign a certificate for another site.
 *
 * The pair is reused across restarts, because every new certificate is a new
 * warning on the phone and a new fingerprint to compare. It is replaced when
 * it no longer fits: a different LAN IP, within RENEW_BEFORE_DAYS of expiry,
 * not valid yet (the clock moved), a key that does not match, or files that
 * fail the trust checks.
 *
 * What a self-signed certificate does and does not give: after the phone has
 * accepted it, the traffic is encrypted and tied to this key. The FIRST
 * visit is trust-on-first-use — the phone has nothing to check the
 * certificate against, so someone already intercepting the Wi-Fi at that
 * moment could present their own. The fingerprint printed next to the link
 * (certFingerprint) is how the owner rules that out: it must match what the
 * phone shows in the certificate's details.
 *
 * Why the certificate is built by hand (a ~100-line DER writer below) and not
 * with a dependency: Node's crypto can sign and can parse X.509 but cannot
 * create one, the usual answers are a 300 kB ASN.1 library (node-forge,
 * selfsigned) or shelling out to an openssl binary that may not exist, and a
 * new dependency in the process that holds the office token is itself a
 * risk. The structure is fixed and small; tests/lan-cert.test.ts parses the
 * result with crypto.X509Certificate, verifies its signature and completes a
 * real TLS handshake against it.
 */

import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'crypto'
import { chmodSync, closeSync, fstatSync, openSync, readFileSync, unlinkSync, writeFileSync, constants as fsConstants } from 'fs'
import { join } from 'path'

export const LAN_CERT_FILE = 'lan-cert.pem'
export const LAN_KEY_FILE = 'lan-key.pem'

const DAY_MS = 24 * 60 * 60 * 1000
// Why 800 days: every new certificate costs the owner a fresh warning and a
// fingerprint check on the phone, so it should last. 825 days is the longest
// a TLS server certificate may run before Apple's platforms reject it even
// when it is installed as trusted (iOS 13+ / macOS 10.15+); 800 stays under it.
export const CERT_VALID_DAYS = 800
// Why 30 days: renewed a month early, at a start, so the certificate never
// lapses while an office that is rarely restarted is still running on it
export const RENEW_BEFORE_DAYS = 30
// Why an hour back: a phone whose clock runs a little behind the Mac's must
// not be told the certificate is not valid yet
const BACKDATE_MS = 60 * 60 * 1000
// Why 16 KiB: a P-256 key or certificate in PEM is under 1 KiB; this only
// stops a planted huge file from being read into memory
const MAX_PEM_BYTES = 16 * 1024

// ---------------------------------------------------------------------------
// DER — the handful of ASN.1 encodings an X.509 certificate needs
// ---------------------------------------------------------------------------

/** A DER length: one byte under 128, else 0x80 | n followed by n big-endian bytes. */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** One tag-length-value: `tag` and the concatenation of `parts`. */
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const sequence = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
const octetString = buf => tlv(0x04, buf)
const utf8String = text => tlv(0x0c, Buffer.from(text, 'utf8'))
const boolean = value => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
/** A BIT STRING of whole bytes: the leading 0 says no bits are unused. */
const bitString = buf => tlv(0x03, Buffer.from([0x00]), buf)
/** [n] EXPLICIT: a context-specific, constructed wrapper around `inner`. */
const explicit = (n, inner) => tlv(0xa0 | n, inner)

/** A non-negative INTEGER from big-endian bytes: minimal, with a 0x00 in front when the top bit is set. */
function integer(bytes) {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const body = bytes.subarray(start)
  return tlv(0x02, body[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), body]) : body)
}

/** An OBJECT IDENTIFIER from dotted text: the first two arcs share a byte, the rest are base 128. */
function oid(dotted) {
  const arcs = dotted.split('.').map(Number)
  const bytes = [arcs[0] * 40 + arcs[1]]
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f]
    for (let rest = arc >>> 7; rest > 0; rest >>>= 7) chunk.unshift((rest & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** A validity time: UTCTime (two-digit year) through 2049, GeneralizedTime from 2050, as RFC 5280 requires. */
function time(date) {
  const p = (n, width = 2) => String(n).padStart(width, '0')
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  const year = date.getUTCFullYear()
  return year < 2050
    ? tlv(0x17, Buffer.from(`${p(year % 100)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${p(year, 4)}${rest}`, 'ascii'))
}

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

/** One Extension: its OID, `critical` when true (DER leaves out a default FALSE), and the DER value in an OCTET STRING. */
function extension(id, critical, value) {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value))
}

/** The four bytes of a dotted-quad IPv4 address, or null. */
function ipv4Bytes(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof ip === 'string' ? ip : '')
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every(n => n <= 255) ? Buffer.from(parts) : null
}

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

/**
 * A new EC P-256 key and a self-signed certificate naming `ip`.
 * @param {string} ip the LAN IPv4 the listener binds; becomes the subjectAltName
 * @param {{ now?: Date, days?: number }} [opts] the clock and the validity (tests pass them)
 * @returns {{ cert: string, key: string }} both PEM
 */
export function generateLanCert(ip, { now = new Date(), days = CERT_VALID_DAYS } = {}) {
  const address = ipv4Bytes(ip)
  if (!address) throw new Error(`not an IPv4 address: ${JSON.stringify(ip)}`)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const algorithm = sequence(oid(OID.ecdsaWithSha256))
  // Issuer and subject are the same name: that is what makes it self-signed
  const name = sequence(set(sequence(oid(OID.commonName), utf8String(`Agent Office phone mode ${ip}`))))
  // Why 16 random bytes with the top bit cleared: a serial must be positive
  // and unique per issuer; a browser that remembers an exception for the old
  // certificate must never confuse a regenerated one with it
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x01

  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),               // version: v3
    integer(serial),
    algorithm,
    name,                                                  // issuer
    sequence(time(new Date(now.getTime() - BACKDATE_MS)), time(new Date(now.getTime() + days * DAY_MS))),
    name,                                                  // subject
    publicKey.export({ type: 'spki', format: 'der' }),     // subjectPublicKeyInfo, as Node encodes it
    explicit(3, sequence(
      // The name browsers check: GeneralNames with one iPAddress ([7] IMPLICIT OCTET STRING)
      extension(OID.subjectAltName, false, sequence(tlv(0x87, address))),
      // Not a CA (an empty BasicConstraints is cA FALSE): the key can sign nothing else
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature only: bit 0, so 7 unused bits and the byte 0x80
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
    )),
  )
  // ECDSA-Sig-Value is itself DER (a SEQUENCE of r and s), carried in a BIT STRING
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const der = sequence(tbs, algorithm, bitString(signature))

  const body = der.toString('base64').match(/.{1,64}/g).join('\n')
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

/**
 * Why a stored pair cannot be used for `ip` now, or null when it can.
 * @param {string} certPem
 * @param {string} keyPem
 * @param {string} ip
 * @param {Date} [now]
 * @returns {string | null}
 */
export function lanCertProblem(certPem, keyPem, ip, now = new Date()) {
  let x509
  let key
  try {
    x509 = new X509Certificate(certPem)
    key = createPrivateKey(keyPem)
  } catch {
    return 'unreadable'
  }
  if (!x509.checkPrivateKey(key)) return 'the key does not match the certificate'
  if (x509.checkIP(ip) === undefined) return 'the LAN address changed'
  if (new Date(x509.validFrom).getTime() > now.getTime()) return 'not valid yet'
  const left = new Date(x509.validTo).getTime() - now.getTime()
  if (left <= 0) return 'expired'
  if (left < RENEW_BEFORE_DAYS * DAY_MS) return `expires in under ${RENEW_BEFORE_DAYS} days`
  return null
}

/**
 * The certificate's SHA-256 fingerprint as browsers show it: 32 bytes, upper-case hex, colon-separated.
 * @param {string} certPem
 * @returns {string}
 */
export function certFingerprint(certPem) {
  return new X509Certificate(certPem).fingerprint256
}

// ---------------------------------------------------------------------------
// The files — the token file's trust checks, for PEM
// ---------------------------------------------------------------------------

/**
 * A file's text if it is safe to trust, else null: the same checks as
 * readTokenFile in server/index.js (which only accepts a 64-hex token, so
 * PEM needs its own reader). A regular file, opened once without following
 * a symlink and checked through that descriptor, owned by this user, with no
 * group or other permission bits. Windows has no uid or mode bits to check.
 * @param {string} file
 * @returns {string | null}
 */
export function readPrivateFile(file) {
  let fd
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_PEM_BYTES) return null
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null
    return readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * Write a 0600 file the way the token file is written: whatever was there is
 * unlinked first and the file created exclusively, so a symlink or a file
 * owned by someone else is replaced rather than written through.
 * @param {string} file
 * @param {string} data
 */
function writePrivateFile(file, data) {
  try { unlinkSync(file) } catch (err) { if (err.code !== 'ENOENT') throw err }
  writeFileSync(file, data, { mode: 0o600, flag: 'wx' })
  try { chmodSync(file, 0o600) } catch {}
}

/**
 * The certificate and key for the full-mode listener on `ip`: the pair in
 * `dir` when it still fits (lanCertProblem), else a new one. A new pair is
 * only in memory until `save()` is called — the listener needs it before it
 * can bind, but, like the token file, nothing is written until the port is
 * ours, so an office that fails to bind never replaces the files a running
 * one started from.
 * @param {string} dir the runtime dir ($AGENT_OFFICE_HOME)
 * @param {string} ip the LAN IPv4
 * @param {{ now?: Date, log?: { warn?: Function } }} [opts]
 * @returns {{ cert: string, key: string, fingerprint: string, reused: boolean, reason: string | null, save: () => void }}
 *   reason: why a stored pair was not used (null when reused, 'none stored'
 *   when there was no pair that passes the trust checks); save: write a new
 *   pair to `dir` (a no-op for a reused one)
 */
export function loadOrCreateLanCert(dir, ip, { now = new Date(), log = console } = {}) {
  const certFile = join(dir, LAN_CERT_FILE)
  const keyFile = join(dir, LAN_KEY_FILE)
  const cert = readPrivateFile(certFile)
  const key = readPrivateFile(keyFile)
  const reason = cert && key ? lanCertProblem(cert, key, ip, now) : 'none stored'
  if (reason === null) return { cert, key, fingerprint: certFingerprint(cert), reused: true, reason: null, save: () => {} }

  const made = generateLanCert(ip, { now })
  const save = () => {
    try {
      // The key first: a certificate whose key was not saved would be reused by
      // nothing, while a saved key without its certificate is simply remade
      writePrivateFile(keyFile, made.key)
      writePrivateFile(certFile, made.cert)
    } catch (err) {
      // Still good for this run; the next start makes another (and the phone warns again)
      log?.warn?.(`[lan] Could not save the LAN certificate (${err.message}); the next start will make a new one`)
    }
  }
  return { ...made, fingerprint: certFingerprint(made.cert), reused: false, reason, save }
}
