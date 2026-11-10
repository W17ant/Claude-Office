/**
 * pageAuth.ts - Takes the office token / viewer key / phone secret out of the address, before anything else runs.
 *
 * main.tsx imports this module FIRST: ES modules run in import order, and
 * App.tsx decides at import time what kind of page this is (a phone-mode
 * viewer page holds a viewer key; a phone-full page was served by the HTTPS
 * LAN listener), so the credential has to be captured before App is
 * evaluated — on the very load that carries it, not only the next.
 *
 * Three links, three credentials, one per kind of page:
 *
 *   #token=   the office link (loopback, or an HTTPS proxy name): the office
 *             token (src/officeToken.ts)
 *   #viewer=  the watch-only phone link (plain HTTP on the Wi-Fi): the viewer
 *             key (src/viewerKey.ts)
 *   #phone=   the full phone link (HTTPS on the Wi-Fi): the phone secret
 *             (src/phoneSecret.ts)
 *
 * All three leave the address bar on every page, before the first render and
 * before the WebSocket that presents one of them. Which one a page KEEPS
 * depends on where it was served from:
 *
 *   a phone-full page          keeps the phone secret only. A stray office
 *                              link or viewer link opened there is stripped
 *                              and anything it stored is cleared: the
 *                              full-mode listener accepts neither, and each
 *                              one presented would count as a wrong secret.
 *   a viewer page, or plain    keeps the viewer key only; never the office
 *   HTTP off loopback          token (it would be readable on the Wi-Fi) and
 *                              never the phone secret (capturePhoneSecret
 *                              keeps it nowhere but a phone-full page)
 *   loopback / an HTTPS name   keeps the office token
 */

import { captureOfficeToken, clearOfficeToken, splitHashParam, stripOfficeToken } from './officeToken'
import { captureViewerKey, clearViewerKey, mayCarryOfficeToken } from './viewerKey'
import { capturePhoneSecret, getPhoneSecret, isPhoneSecret, onPhoneFullPage, PHONE_OFF } from './phoneSecret'

/** True when this page was served by the full-mode LAN listener (https on a private IPv4 literal). */
export const isPhoneFullPage: boolean = onPhoneFullPage()

/** The phone secret this page holds after the capture, or null. Always null off a phone-full page. */
export const pagePhoneSecret: string | null = capturePhoneSecret()

// Why captured even on a phone-full page: capturing is also what strips
// `#viewer=` from the address; the key itself is dropped again just below
const capturedViewerKey: string | null = captureViewerKey()
if (isPhoneFullPage && capturedViewerKey) clearViewerKey()

/** The viewer key this page holds after the capture, or null (a normal office page, or a phone-full page). */
export const pageViewerKey: string | null = isPhoneFullPage ? null : capturedViewerKey

if (isPhoneFullPage) {
  // Why cleared as well as stripped: this origin never legitimately held an
  // office token (the full-mode listener refuses it), so one found in storage
  // can only have been put there by a stray link — and must not be offered
  stripOfficeToken()
  clearOfficeToken()
} else if (pageViewerKey || !mayCarryOfficeToken(window.location)) {
  stripOfficeToken()
} else {
  captureOfficeToken()
}

// A phone link opened in a tab that already shows the office (scanning the QR
// code again after `--rotate`) only changes the fragment: no page load, so
// the capture above never runs and the secret would sit in the address bar.
// Take it out here too, then reload so every part of the page starts from the
// secret it now holds. Phone-full pages only: the other two links keep the
// behaviour they have always had.
if (isPhoneFullPage) {
  window.addEventListener('hashchange', () => {
    const { found, value, raw } = splitHashParam(window.location.hash, 'phone', isPhoneSecret)
    if (!found) return
    const before = getPhoneSecret()
    const after = capturePhoneSecret()
    // Why not reload on a malformed value: it changed nothing, and the
    // address is already clean
    if (after !== before && (value !== null || raw === PHONE_OFF)) window.location.reload()
  })
}
