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
// rejects the latter.
const params = new URLSearchParams(window.location.search)
const standalone = params.has('sim') || params.has('video')
const ready = standalone ? Promise.resolve(null) : loadRuntimeConfig()
ready.then(render, render)
