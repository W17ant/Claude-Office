// Real-time day/night cycle based on system clock
// Uses solar position approximation for sunrise/sunset

export type DayPhase = 'night' | 'dawn' | 'morning' | 'afternoon' | 'evening' | 'dusk'

interface SunTimes {
  sunrise: number  // hour (decimal)
  sunset: number
}

/**
 * Approximate sunrise/sunset for a given date and latitude.
 * Uses a simplified solar equation - accurate to ~15 minutes.
 */
function getSunTimes(date: Date, latitude: number): SunTimes {
  const dayOfYear = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000
  )

  // Solar declination (simplified)
  const declination = -23.45 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180))

  // Hour angle
  const latRad = latitude * (Math.PI / 180)
  const declRad = declination * (Math.PI / 180)
  const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad)

  // Clamp for polar regions
  const clamped = Math.max(-1, Math.min(1, cosHourAngle))
  const hourAngle = Math.acos(clamped) * (180 / Math.PI)

  const sunrise = 12 - hourAngle / 15
  const sunset = 12 + hourAngle / 15

  return { sunrise, sunset }
}

/**
 * Get current day phase based on real system time.
 * Latitude defaults to London (~51.5) but can be overridden.
 */
export function getCurrentPhase(latitude = 51.5): DayPhase {
  const now = new Date()
  const hour = now.getHours() + now.getMinutes() / 60
  const { sunrise, sunset } = getSunTimes(now, latitude)

  const dawnStart = sunrise - 0.75    // ~45 min before sunrise
  const morningStart = sunrise + 0.5  // 30 min after sunrise
  const eveningStart = sunset - 1.5   // 1.5 hr before sunset
  const duskStart = sunset - 0.25     // 15 min before sunset
  const nightStart = sunset + 0.75    // 45 min after sunset

  if (hour < dawnStart) return 'night'
  if (hour < morningStart) return 'dawn'
  if (hour < 12) return 'morning'
  if (hour < eveningStart) return 'afternoon'
  if (hour < duskStart) return 'evening'
  if (hour < nightStart) return 'dusk'
  return 'night'
}

/**
 * Get phase label for Slack announcements
 */
export function getPhaseLabel(phase: DayPhase): string {
  switch (phase) {
    case 'night':     return '🌙 Night shift'
    case 'dawn':      return '🌅 Dawn is breaking'
    case 'morning':   return '☀️ Good morning'
    case 'afternoon': return '☀️ Afternoon'
    case 'evening':   return '🌆 Evening'
    case 'dusk':      return '🌇 Sun is setting'
  }
}

/**
 * Is it currently "dark" (should show night background)?
 */
export function isDark(phase: DayPhase): boolean {
  return phase === 'night' || phase === 'dusk' || phase === 'dawn'
}
