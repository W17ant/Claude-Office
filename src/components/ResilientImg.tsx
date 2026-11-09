/** ResilientImg - an <img> that survives the office server being away for a moment. */
import React, { useEffect, useRef, useState } from 'react'

// Why: a server restart takes a few seconds; 3 s between probes and at most
// 5 retries covers ~15 s of downtime without polling a dead server forever.
const RETRY_MS = 3000
const MAX_TRIES = 5

/**
 * A sprite for a new direction, a new effect or a new piece of furniture is
 * fetched the first time it is needed; if the server is not reachable just then
 * the browser shows a broken picture with its alt text. This keeps showing the
 * last picture that loaded and asks for the missing one again every RETRY_MS (at
 * most MAX_TRIES times), switching to it as soon as it can be loaded.
 *
 * Takes every ordinary <img> prop; `src` is required.
 *
 * Adapted from EooL's #64.
 */
const ResilientImg: React.FC<React.ImgHTMLAttributes<HTMLImageElement> & { src: string }> = ({ src, onLoad, onError, alt = '', ...rest }) => {
  const good = useRef<string | null>(null)
  const [failed, setFailed] = useState<{ src: string, tries: number } | null>(null)
  // Why: when nothing has loaded yet the <img> keeps the same src the whole
  // time, so clearing `failed` alone would never make the browser ask again.
  // Bumping the key remounts the element, which fetches the picture afresh.
  const [reloads, setReloads] = useState(0)
  // Why: a failure belongs to the picture that failed. Kept across a src
  // change (a character turning), it came back when the old src did, showed
  // the other direction's sprite and, with the retries used up, never asked
  // for the right one again. Reset during render (React's "adjust state when
  // a prop changes"), so not even one frame uses the stale failure.
  const [forSrc, setForSrc] = useState(src)
  if (forSrc !== src) {
    setForSrc(src)
    setFailed(null)
  }
  const tries = failed?.src === src ? failed.tries : 0
  const shown = tries > 0 && good.current && good.current !== src ? good.current : src

  useEffect(() => {
    if (!failed || failed.src !== src || failed.tries > MAX_TRIES) return
    let probe: HTMLImageElement | null = null
    const timer = setTimeout(() => {
      probe = new Image()
      probe.onload = () => { setFailed(null); setReloads(n => n + 1) } // reachable again: ask for the real picture
      probe.onerror = () => setFailed({ src, tries: failed.tries + 1 })
      probe.src = `${src}${src.includes('?') ? '&' : '?'}retry=${failed.tries}`
    }, RETRY_MS)
    return () => { clearTimeout(timer); if (probe) { probe.onload = null; probe.onerror = null } }
  }, [failed, src])

  return (
    <img
      key={reloads}
      {...rest}
      src={shown}
      alt={alt}
      onLoad={(event) => { if (shown === src) good.current = src; onLoad?.(event) }}
      onError={(event) => { if (shown === src) setFailed({ src, tries: tries + 1 }); onError?.(event) }}
    />
  )
}

export default ResilientImg
