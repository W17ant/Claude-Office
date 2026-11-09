// ResilientImg shows the picture it is given and passes every ordinary <img> prop through; the keep-the-last-picture
// and retry behaviour needs a browser and was checked in one (headless Chrome against a server that fails the second
// picture three times: it kept showing the first, then switched once the second could be loaded).
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ResilientImg from '../src/components/ResilientImg'

describe('ResilientImg', () => {
  it('renders a plain image with the given source, alt text and props', () => {
    const html = renderToStaticMarkup(React.createElement(ResilientImg, { src: '/sprites/a.png', alt: 'Boss', className: 'char-sprite', draggable: false, width: 40 }))
    expect(html).toContain('src="/sprites/a.png"')
    expect(html).toContain('alt="Boss"')
    expect(html).toContain('class="char-sprite"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain('width="40"')
  })

  it('always renders an alt attribute, empty when none is given', () => {
    expect(renderToStaticMarkup(React.createElement(ResilientImg, { src: '/x.png' }))).toContain('alt=""')
  })
})
