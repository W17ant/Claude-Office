/**
 * EffectBubble — a small floating sprite that appears above a character.
 *
 * Renders one of the effect sprites from /public/sprites/effects/ and
 * animates it with a gentle bob so it feels alive.
 */

import React from 'react'
import ResilientImg from './ResilientImg'
import { useT } from '../i18n'

interface EffectBubbleProps {
  /** Full path to the sprite, e.g. '/sprites/effects/typing.png' */
  src: string
  /** Accessible label (a generic "effect" when none is given) */
  alt?: string
}

const EffectBubble: React.FC<EffectBubbleProps> = ({ src, alt }) => {
  const tr = useT()
  return (
    <div className="effect-bubble">
      <ResilientImg
        src={src}
        alt={alt ?? tr('ui.character.effect')}
        className="effect-bubble-img"
        draggable={false}
      />
    </div>
  )
}

export default EffectBubble
