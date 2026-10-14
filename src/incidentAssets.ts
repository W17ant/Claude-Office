/**
 * incidentAssets.ts — asset slots for incident mode.
 *
 * v1 ships with EXISTING art only. Each slot names the PNG the real incident
 * art should land at (see the design spec, section 2.2) and the existing
 * sprite to use until it exists. Drop the real PNG at `intended` and the
 * office picks it up on the next load — no code change needed. A slot with
 * `fallback: null` renders nothing until its PNG is drawn.
 *
 * Detection is a runtime image probe (one HEAD-equivalent <img> load per slot
 * per page load) rather than a build-time glob, because files in public/
 * cannot be imported from JavaScript and the Electron build serves them as
 * plain files. Missing intended files show up as a handful of 404s in the
 * devtools network tab on load; that is expected until the art is drawn.
 */

export interface IncidentAssetSlot {
  /** Where the real art should go. */
  intended: string
  /** Existing art used until `intended` exists; null = render nothing. */
  fallback: string | null
  /** What the slot is for. */
  note: string
}

export const INCIDENT_ASSETS = {
  beacon: {
    intended: '/sprites/incident/beacon-0.png',
    fallback: '/sprites/effects/fire.png',
    note: 'Rotating red beacon, frame A (lens dark). Mounted on the wall above the door.',
  },
  beaconLit: {
    intended: '/sprites/incident/beacon-1.png',
    fallback: '/sprites/effects/fire.png',
    note: 'Beacon frame B (lens lit). Alternates with frame A at ~1.2 Hz.',
  },
  statusScreen: {
    intended: '/sprites/incident/status-screen.png',
    fallback: '/sprites/culture/deploying-screen.png',
    note: 'Wall TV during an incident — reads as the ROLLBACK status page.',
  },
  daysSign: {
    intended: '/sprites/culture/days-last-incident.png',
    fallback: '/sprites/culture/days-last-incident.png',
    note: '"Days since last incident" sign on the left wall; the digit is drawn live over the art.',
  },
  failedBubble: {
    intended: '/sprites/effects/build-failed.png',
    fallback: '/sprites/effects/build-failed.png',
    note: 'Bubble above an agent whose last tool call failed (incident mode only).',
  },
  incidentBoard: {
    intended: '/sprites/incident/incident-board.png',
    fallback: null,
    note: 'Incident timeline whiteboard over the kanban board hotspot (80%, 42%). Hidden until drawn.',
  },
  pizzaTower0: {
    intended: '/sprites/incident/pizza-tower-0.png',
    fallback: null,
    note: 'One pizza box on the coffee counter (first 10 min of an incident). Hidden until drawn.',
  },
  pizzaTower1: {
    intended: '/sprites/incident/pizza-tower-1.png',
    fallback: null,
    note: 'Three pizza boxes (10-30 min). Hidden until drawn.',
  },
  pizzaTower2: {
    intended: '/sprites/incident/pizza-tower-2.png',
    fallback: null,
    note: 'Six leaning pizza boxes (30 min+). Hidden until drawn.',
  },
} as const satisfies Record<string, IncidentAssetSlot>

export type IncidentAssetName = keyof typeof INCIDENT_ASSETS

// ---------------------------------------------------------------------------
// Runtime probe: does the intended file exist?
// ---------------------------------------------------------------------------

const probeResults = new Map<string, boolean>()
const probesInFlight = new Map<string, Promise<boolean>>()
const probeListeners = new Set<() => void>()

/** Resolve true when `url` loads as an image. Cached per URL. */
export function probeImage(url: string): Promise<boolean> {
  const known = probeResults.get(url)
  if (known !== undefined) return Promise.resolve(known)
  const inFlight = probesInFlight.get(url)
  if (inFlight) return inFlight

  const p = new Promise<boolean>(resolve => {
    if (typeof Image === 'undefined') { resolve(false); return }
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth > 0)
    img.onerror = () => resolve(false)
    img.src = url
  }).then(ok => {
    probeResults.set(url, ok)
    probesInFlight.delete(url)
    probeListeners.forEach(l => l())
    return ok
  })
  probesInFlight.set(url, p)
  return p
}

/** Kick off probes for every slot whose intended file differs from its fallback. */
export function probeIncidentAssets(): Promise<void> {
  const urls = Object.values(INCIDENT_ASSETS)
    .filter(slot => slot.intended !== slot.fallback)
    .map(slot => slot.intended)
  return Promise.all(urls.map(probeImage)).then(() => undefined)
}

/**
 * Synchronous lookup: the intended URL once a probe has confirmed it,
 * otherwise the fallback (which may be null = draw nothing). Slots whose
 * intended file IS the fallback need no probe.
 */
export function incidentAssetUrl(name: IncidentAssetName): string | null {
  const slot: IncidentAssetSlot = INCIDENT_ASSETS[name]
  if (slot.intended === slot.fallback) return slot.intended
  return probeResults.get(slot.intended) === true ? slot.intended : slot.fallback
}

export function subscribeIncidentAssets(fn: () => void): () => void {
  probeListeners.add(fn)
  return () => probeListeners.delete(fn)
}

/** Test hook. */
export function _setProbeResultForTests(url: string, ok: boolean) {
  probeResults.set(url, ok)
}
