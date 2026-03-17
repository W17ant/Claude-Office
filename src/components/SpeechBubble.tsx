import React, { useEffect, useState } from 'react'

interface SpeechBubbleProps {
  text: string
  isManager?: boolean
  duration?: number
}

const SpeechBubble: React.FC<SpeechBubbleProps> = ({ text, isManager = false, duration = 3000 }) => {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), duration)
    return () => clearTimeout(timer)
  }, [text, duration])

  if (!visible) return null

  return (
    <div className={`speech-bubble${isManager ? ' manager-bubble' : ''}`}>
      {text}
    </div>
  )
}

export default SpeechBubble
