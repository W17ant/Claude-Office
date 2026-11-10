/**
 * lan-cert.test.ts - Phone full mode's certificate (server/lan-cert.js): the hand-built X.509, its files, reuse and regeneration.
 *
 * The certificate is written byte by byte (a small DER writer), so nothing
 * here trusts the writer's own idea of what it wrote: every certificate is
 * parsed back with Node's crypto.X509Certificate, its signature verified
 * against its own key, and a real TLS handshake completed against a server
 * using it — by a client that trusts only that certificate and checks the
 * name. Then the files: nothing on disk before save(), 0600 after, reused
 * while they fit, replaced when the LAN address changes, when the
 * certificate nears expiry, and when a file stops passing the trust checks.
 */

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CERT_VALID_DAYS, LAN_CERT_FILE, LAN_KEY_FILE, RENEW_BEFORE_DAYS,
  certFingerprint, generateLanCert, lanCertProblem, loadOrCreateLanCert, readPrivateFile,
} from '../server/lan-cert.js'

const DAY_MS = 24 * 60 * 60 * 1000
const IP = '192.168.1.23'
const posix = process.platform !== 'win32'
const quiet = { warn: () => {} }

/** A TLS client that trusts exactly `ca`; resolves how the handshake went. */
function handshake(port: number, ca: string, host = '127.0.0.1'): Promise<{ authorized: boolean; error?: string; protocol?: string | null }> {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, ca }, () => {
      resolve({ authorized: socket.authorized, protocol: socket.getProtocol() })
      socket.end()
    })
    socket.on('error', err => resolve({ authorized: false, error: (err as NodeJS.ErrnoException).code ?? err.message }))
  })
}

describe('generateLanCert: an X.509 certificate Node itself can read', () => {
  it('is a v3, self-signed, ECDSA P-256 certificate whose one name is the LAN IP', () => {
    const now = new Date('2026-03-01T12:00:00Z')
    const { cert, key } = generateLanCert(IP, { now })
    const x = new X509Certificate(cert)

    expect(x.subject).toBe(`CN=Agent Office phone mode ${IP}`)
    expect(x.issuer).toBe(x.subject)
    expect(x.subjectAltName).toBe(`IP Address:${IP}`)
    // Self-signed: its own public key verifies its signature
    expect(x.verify(x.publicKey)).toBe(true)
    // ...but it is no issuer: OpenSSL's issuer check wants keyCertSign, which
    // a certificate that is not a CA must not assert (RFC 5280 4.2.1.3)
    expect(x.checkIssued(x)).toBe(false)
    expect(x.publicKey.asymmetricKeyType).toBe('ec')
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    // The private key handed back is the one in the certificate
    expect(x.checkPrivateKey(createPrivateKey(key))).toBe(true)
    // Not a CA: installed as trusted, the key still cannot vouch for another site
    expect(x.ca).toBe(false)
    // Extended key usage: TLS server authentication, nothing else
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])

    // The name: this IP and no other, never a host name
    expect(x.checkIP(IP)).toBe(IP)
    expect(x.checkIP('192.168.1.24')).toBeUndefined()
    expect(x.checkIP('10.0.0.1')).toBeUndefined()
    expect(x.checkHost('localhost')).toBeUndefined()
    expect(x.checkHost(IP)).toBeUndefined()
  })

  it('is valid from an hour ago (a phone clock a little behind) for CERT_VALID_DAYS', () => {
    const now = new Date('2026-03-01T12:00:00Z')
    const x = new X509Certificate(generateLanCert(IP, { now }).cert)
    expect(new Date(x.validFrom).getTime()).toBe(now.getTime() - 60 * 60 * 1000)
    expect(new Date(x.validTo).getTime()).toBe(now.getTime() + CERT_VALID_DAYS * DAY_MS)
    // Under Apple's 825-day ceiling for a TLS server certificate
    expect(CERT_VALID_DAYS).toBeLessThanOrEqual(825)
  })

  it('writes a date past 2049 as GeneralizedTime (RFC 5280) and Node still reads it', () => {
    const now = new Date('2049-06-01T00:00:00Z')
    const x = new X509Certificate(generateLanCert(IP, { now }).cert)
    expect(new Date(x.validFrom).getUTCFullYear()).toBe(2049)
    expect(new Date(x.validTo).getTime()).toBe(now.getTime() + CERT_VALID_DAYS * DAY_MS)
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2051)
  })

  it('never repeats: a new key, a new positive serial and a new fingerprint every time', () => {
    const made = Array.from({ length: 8 }, () => generateLanCert(IP))
    const xs = made.map(m => new X509Certificate(m.cert))
    expect(new Set(xs.map(x => x.serialNumber)).size).toBe(8)
    expect(new Set(xs.map(x => x.fingerprint256)).size).toBe(8)
    expect(new Set(made.map(m => m.key)).size).toBe(8)
    // Positive, at most 16 bytes: the top bit of the first byte is clear, so no 17th sign byte
    for (const x of xs) expect(x.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/)
  })

  it('handles every private range, and octets that need each DER length', () => {
    for (const ip of ['10.0.0.1', '172.16.254.1', '192.168.100.200', '10.255.255.255', '127.0.0.1']) {
      const x = new X509Certificate(generateLanCert(ip).cert)
      expect(x.subjectAltName, ip).toBe(`IP Address:${ip}`)
      expect(x.verify(x.publicKey), ip).toBe(true)
    }
  })

  it('refuses anything that is not an IPv4 literal', () => {
    for (const bad of ['', 'localhost', 'my-mac.local', '::1', '192.168.1', '192.168.1.256', '192.168.1.1.1', ' 192.168.1.2', undefined, null, 42]) {
      expect(() => generateLanCert(bad as any), String(bad)).toThrow(/not an IPv4 address/)
    }
  })

  it('certFingerprint: SHA-256 as a browser shows it, and the same as X509Certificate.fingerprint256', () => {
    const { cert } = generateLanCert(IP)
    const fp = certFingerprint(cert)
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(fp).toBe(new X509Certificate(cert).fingerprint256)
  })
})

describe('generateLanCert: a real TLS handshake', () => {
  let server: https.Server | undefined
  afterEach(async () => {
    const closing = server
    server = undefined
    if (closing) {
      closing.closeAllConnections?.()
      await new Promise<void>(res => closing.close(() => res()))
    }
  })

  /** An https server on 127.0.0.1 using `pair`; returns its port. */
  const serve = (pair: { cert: string; key: string }) => new Promise<number>(resolve => {
    server = https.createServer({ cert: pair.cert, key: pair.key, minVersion: 'TLSv1.2' }, (_req, res) => res.end('ok'))
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port))
  })

  it('completes, authorized, for a client that trusts only this certificate and checks the address', async () => {
    const pair = generateLanCert('127.0.0.1')
    const port = await serve(pair)
    const result = await handshake(port, pair.cert)
    expect(result.error).toBeUndefined()
    expect(result.authorized).toBe(true)
    expect(result.protocol).toMatch(/^TLSv1\.[23]$/)
  })

  it('fails for a client that trusts a different certificate (what an impostor on the Wi-Fi would present)', async () => {
    const port = await serve(generateLanCert('127.0.0.1'))
    const result = await handshake(port, generateLanCert('127.0.0.1').cert)
    expect(result.authorized).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('fails when the certificate names another address', async () => {
    const pair = generateLanCert('192.168.1.23')
    const port = await serve(pair)
    const result = await handshake(port, pair.cert)
    expect(result.authorized).toBe(false)
    expect(result.error).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
  })
})

describe('lanCertProblem: when a stored pair no longer fits', () => {
  const now = new Date('2026-03-01T12:00:00Z')
  const pair = generateLanCert(IP, { now })

  it('fits: the same address, inside its validity', () => {
    expect(lanCertProblem(pair.cert, pair.key, IP, now)).toBeNull()
    expect(lanCertProblem(pair.cert, pair.key, IP, new Date(now.getTime() + 100 * DAY_MS))).toBeNull()
  })

  it('the LAN address changed', () => {
    expect(lanCertProblem(pair.cert, pair.key, '192.168.1.24', now)).toBe('the LAN address changed')
    expect(lanCertProblem(pair.cert, pair.key, '10.0.0.5', now)).toBe('the LAN address changed')
  })

  it('near expiry, expired, and not valid yet', () => {
    const at = (days: number) => new Date(now.getTime() + days * DAY_MS)
    expect(lanCertProblem(pair.cert, pair.key, IP, at(CERT_VALID_DAYS - RENEW_BEFORE_DAYS - 1))).toBeNull()
    expect(lanCertProblem(pair.cert, pair.key, IP, at(CERT_VALID_DAYS - RENEW_BEFORE_DAYS + 1))).toBe(`expires in under ${RENEW_BEFORE_DAYS} days`)
    expect(lanCertProblem(pair.cert, pair.key, IP, at(CERT_VALID_DAYS + 1))).toBe('expired')
    // The clock was set back past the certificate's start (it is backdated one hour)
    expect(lanCertProblem(pair.cert, pair.key, IP, new Date(now.getTime() - 2 * 60 * 60 * 1000))).toBe('not valid yet')
  })

  it('a key that is not the certificate\'s, and files that are not PEM', () => {
    const other = generateLanCert(IP, { now })
    expect(lanCertProblem(pair.cert, other.key, IP, now)).toBe('the key does not match the certificate')
    expect(lanCertProblem('not a certificate', pair.key, IP, now)).toBe('unreadable')
    expect(lanCertProblem(pair.cert, 'not a key', IP, now)).toBe('unreadable')
    expect(lanCertProblem('', '', IP, now)).toBe('unreadable')
  })
})

describe('loadOrCreateLanCert: the files in the runtime dir', () => {
  const dirs: string[] = []
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-cert-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('makes a pair but writes nothing until save(); then both files are 0600', () => {
    const dir = tempDir()
    const made = loadOrCreateLanCert(dir, IP, { log: quiet })
    expect(made).toMatchObject({ reused: false, reason: 'none stored' })
    expect(made.fingerprint).toBe(certFingerprint(made.cert))
    expect(existsSync(join(dir, LAN_CERT_FILE))).toBe(false)
    expect(existsSync(join(dir, LAN_KEY_FILE))).toBe(false)

    made.save()
    expect(readFileSync(join(dir, LAN_CERT_FILE), 'utf8')).toBe(made.cert)
    expect(readFileSync(join(dir, LAN_KEY_FILE), 'utf8')).toBe(made.key)
    if (posix) {
      expect(statSync(join(dir, LAN_KEY_FILE)).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, LAN_CERT_FILE)).mode & 0o777).toBe(0o600)
    }
  })

  it('reuses a saved pair: the same certificate, the same fingerprint, no new warning on the phone', () => {
    const dir = tempDir()
    const first = loadOrCreateLanCert(dir, IP, { log: quiet })
    first.save()
    const second = loadOrCreateLanCert(dir, IP, { log: quiet })
    expect(second).toMatchObject({ reused: true, reason: null, cert: first.cert, key: first.key, fingerprint: first.fingerprint })
    // save() on a reused pair touches nothing
    const before = statSync(join(dir, LAN_KEY_FILE)).mtimeMs
    second.save()
    expect(statSync(join(dir, LAN_KEY_FILE)).mtimeMs).toBe(before)
  })

  it('makes a new one when the LAN address changes, and the new one replaces the files', () => {
    const dir = tempDir()
    const first = loadOrCreateLanCert(dir, IP, { log: quiet })
    first.save()
    const moved = loadOrCreateLanCert(dir, '192.168.1.99', { log: quiet })
    expect(moved).toMatchObject({ reused: false, reason: 'the LAN address changed' })
    expect(moved.fingerprint).not.toBe(first.fingerprint)
    expect(new X509Certificate(moved.cert).subjectAltName).toBe('IP Address:192.168.1.99')
    moved.save()
    expect(readFileSync(join(dir, LAN_CERT_FILE), 'utf8')).toBe(moved.cert)
    expect(loadOrCreateLanCert(dir, '192.168.1.99', { log: quiet })).toMatchObject({ reused: true, fingerprint: moved.fingerprint })
    // ...and going back to the old address is one more new certificate, not the first one
    expect(loadOrCreateLanCert(dir, IP, { log: quiet }).reused).toBe(false)
  })

  it('makes a new one when the stored certificate is within RENEW_BEFORE_DAYS of expiry, or past it', () => {
    const dir = tempDir()
    const now = new Date('2026-03-01T12:00:00Z')
    const first = loadOrCreateLanCert(dir, IP, { now, log: quiet })
    first.save()
    const at = (days: number) => new Date(now.getTime() + days * DAY_MS)
    expect(loadOrCreateLanCert(dir, IP, { now: at(CERT_VALID_DAYS - RENEW_BEFORE_DAYS - 1), log: quiet }).reused).toBe(true)
    const renewed = loadOrCreateLanCert(dir, IP, { now: at(CERT_VALID_DAYS - 10), log: quiet })
    expect(renewed).toMatchObject({ reused: false, reason: `expires in under ${RENEW_BEFORE_DAYS} days` })
    // The renewed certificate runs a full term from that day
    expect(new Date(new X509Certificate(renewed.cert).validTo).getTime()).toBe(at(CERT_VALID_DAYS - 10).getTime() + CERT_VALID_DAYS * DAY_MS)
    expect(loadOrCreateLanCert(dir, IP, { now: at(CERT_VALID_DAYS + 5), log: quiet })).toMatchObject({ reused: false, reason: 'expired' })
  })

  it('makes a new one when half the pair is missing or the two do not belong together', () => {
    const dir = tempDir()
    const first = loadOrCreateLanCert(dir, IP, { log: quiet })
    first.save()
    unlinkSync(join(dir, LAN_KEY_FILE))
    expect(loadOrCreateLanCert(dir, IP, { log: quiet })).toMatchObject({ reused: false, reason: 'none stored' })

    first.save()
    writeFileSync(join(dir, LAN_KEY_FILE), generateLanCert(IP).key, { mode: 0o600 })
    expect(loadOrCreateLanCert(dir, IP, { log: quiet })).toMatchObject({ reused: false, reason: 'the key does not match the certificate' })

    writeFileSync(join(dir, LAN_CERT_FILE), 'garbage', { mode: 0o600 })
    expect(loadOrCreateLanCert(dir, IP, { log: quiet })).toMatchObject({ reused: false, reason: 'unreadable' })
  })

  it.skipIf(!posix)('does not trust a key or certificate file that others can read', () => {
    for (const file of [LAN_KEY_FILE, LAN_CERT_FILE]) {
      const dir = tempDir()
      const first = loadOrCreateLanCert(dir, IP, { log: quiet })
      first.save()
      chmodSync(join(dir, file), 0o644)
      expect(readPrivateFile(join(dir, file)), file).toBeNull()
      const again = loadOrCreateLanCert(dir, IP, { log: quiet })
      expect(again, file).toMatchObject({ reused: false, reason: 'none stored' })
      again.save()
      // The replacement is private again
      expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600)
      expect(loadOrCreateLanCert(dir, IP, { log: quiet }).fingerprint).toBe(again.fingerprint)
    }
  })

  it.skipIf(!posix)('does not follow a symlink: neither to read a planted key nor to write through it', () => {
    const dir = tempDir()
    const elsewhere = tempDir()
    const planted = generateLanCert(IP)
    const plantedKey = join(elsewhere, 'planted-key.pem')
    const plantedCert = join(elsewhere, 'planted-cert.pem')
    writeFileSync(plantedKey, planted.key, { mode: 0o600 })
    writeFileSync(plantedCert, planted.cert, { mode: 0o600 })
    symlinkSync(plantedKey, join(dir, LAN_KEY_FILE))
    symlinkSync(plantedCert, join(dir, LAN_CERT_FILE))

    expect(readPrivateFile(join(dir, LAN_KEY_FILE))).toBeNull()
    const made = loadOrCreateLanCert(dir, IP, { log: quiet })
    expect(made.reused).toBe(false)
    expect(made.fingerprint).not.toBe(certFingerprint(planted.cert))
    made.save()
    // The links were replaced by real files; what they pointed at is untouched
    expect(statSync(join(dir, LAN_KEY_FILE)).isFile()).toBe(true)
    expect(readFileSync(join(dir, LAN_KEY_FILE), 'utf8')).toBe(made.key)
    expect(readFileSync(plantedKey, 'utf8')).toBe(planted.key)
    expect(readFileSync(plantedCert, 'utf8')).toBe(planted.cert)
  })

  it('readPrivateFile: a missing file, a directory and an oversized file are all "not there"', () => {
    const dir = tempDir()
    expect(readPrivateFile(join(dir, 'nope.pem'))).toBeNull()
    expect(readPrivateFile(dir)).toBeNull()
    writeFileSync(join(dir, 'big.pem'), 'x'.repeat(17 * 1024), { mode: 0o600 })
    expect(readPrivateFile(join(dir, 'big.pem'))).toBeNull()
    writeFileSync(join(dir, 'ok.pem'), 'hello', { mode: 0o600 })
    expect(readPrivateFile(join(dir, 'ok.pem'))).toBe('hello')
  })

  it('a failed save is a warning, not a crash: the pair still serves this run', () => {
    const warnings: string[] = []
    const made = loadOrCreateLanCert(join(tempDir(), 'does', 'not', 'exist'), IP, { log: { warn: (m: string) => warnings.push(m) } })
    expect(() => made.save()).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Could not save the LAN certificate/)
    expect(new X509Certificate(made.cert).checkIP(IP)).toBe(IP)
  })
})
