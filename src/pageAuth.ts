/**
 * pageAuth.ts - Takes the office token / viewer key out of the address, before anything else runs.
 *
 * main.tsx imports this module FIRST: ES modules run in import order, and
 * App.tsx decides at import time whether the page is a phone-mode viewer
 * page (it holds a viewer key), so the key has to be captured before App is
 * evaluated — on the very load that carries `#viewer=`, not only the next.
 *
 * The phone link carries a viewer key (#viewer=...), the office link the
 * token (#token=...): keep whichever this page may hold and take both out of
 * the address bar before the first render and the WebSocket that presents
 * them (src/viewerKey.ts, src/officeToken.ts). A viewer page, or a plain-HTTP
 * page off loopback, never keeps the office token.
 */

import { captureOfficeToken, stripOfficeToken } from './officeToken'
import { captureViewerKey, mayCarryOfficeToken } from './viewerKey'

/** The viewer key this page holds after the capture, or null (a normal office page). */
export const pageViewerKey: string | null = captureViewerKey()

if (pageViewerKey || !mayCarryOfficeToken(window.location)) stripOfficeToken()
else captureOfficeToken()
