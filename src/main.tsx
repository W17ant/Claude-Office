// First: the office token / viewer key / phone secret leave the address bar
// before App is even evaluated (src/pageAuth.ts says why the order matters)
import { isPhoneFullPage, pagePhoneSecret, pageViewerKey as viewerKey } from './pageAuth'
import { mayCarryOfficeToken } from './viewerKey'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { loadRuntimeConfig } from './config'

function render() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// The boss's name, sprite and colour come from the server's office.config.json
// (GET /config) and are applied before the first render, so nothing captures
// the bundled name first. ?sim and ?video have no server, and the Vite dev
// server may run without one: those render at once, and a server that does
// not answer within loadRuntimeConfig's timeout leaves the build-time boss
// in place. A promise chain rather than top-level await: the build target
// rejects the latter. A viewer page skips it: GET /config is an API route,
// which the LAN listener answers 404 — the bundled boss is drawn instead.
// A phone-full page (the HTTPS LAN listener) does ask, with its phone secret
// (src/officeAuth.ts); one that holds no secret would only be answered 401,
// so it skips the request and App shows how to get the link.
const params = new URLSearchParams(window.location.search)
const phoneWithoutSecret = isPhoneFullPage && pagePhoneSecret === null
const standalone = params.has('sim') || params.has('video') || !!viewerKey || !mayCarryOfficeToken(window.location) || phoneWithoutSecret
const ready = standalone ? Promise.resolve(null) : loadRuntimeConfig()
ready.then(render, render)
