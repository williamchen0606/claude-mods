import type { RenderElement } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { captureError, droppedImagePath, fitCells, imageIds, parseCapture } from '../hooks/preview'

describe('imageIds', () => {
  test('lists each placeholder once, in order', () => {
    expect(imageIds('look [Image #2] and [Image #1] vs [Image #2]')).toEqual([2, 1])
  })

  test('ignores text that is not a placeholder', () => {
    expect(imageIds('[Image #] [image #3] Image #4')).toEqual([])
  })
})

describe('droppedImagePath', () => {
  test('takes a bare, quoted or escaped absolute path to an image', () => {
    expect(droppedImagePath('/tmp/shot.png')).toBe('/tmp/shot.png')
    expect(droppedImagePath("'/tmp/my shot.JPG' ")).toBe('/tmp/my shot.JPG')
    expect(droppedImagePath('/tmp/my\\ shot.webp')).toBe('/tmp/my shot.webp')
    expect(droppedImagePath('file:///tmp/a%20b.png')).toBe('/tmp/a b.png')
  })

  test('rejects text, relative paths and other files', () => {
    expect(droppedImagePath('[Image #1]')).toBeNull()
    expect(droppedImagePath('shot.png')).toBeNull()
    expect(droppedImagePath('/tmp/notes.txt')).toBeNull()
    expect(droppedImagePath('')).toBeNull()
  })
})

describe('fitCells', () => {
  test('keeps the aspect ratio at the row limit', () => {
    expect(fitCells(1600, 900, 200, 8)).toEqual({ columns: 28, rows: 8 })
  })

  test('shrinks the rows when the width is the limit', () => {
    expect(fitCells(4000, 500, 40, 8)).toEqual({ columns: 40, rows: 3 })
  })

  test('never goes below one cell', () => {
    expect(fitCells(10000, 1, 20, 8)).toEqual({ columns: 20, rows: 1 })
  })
})

describe('parseCapture', () => {
  test('reads path and size', () => {
    expect(parseCapture('/tmp/claude-image-preview/a b.png 640 480\n')).toEqual({
      path: '/tmp/claude-image-preview/a b.png',
      width: 640,
      height: 480,
    })
  })

  test('rejects anything else', () => {
    expect(parseCapture('')).toBeNull()
    expect(parseCapture('/tmp/x.png 0 480')).toBeNull()
  })
})

test('captureError names the empty clipboard', () => {
  expect(captureError(11)).toBe('剪貼簿裡沒有圖片')
  expect(captureError(99)).toMatch('99')
})

test('draws nothing of its own while no image is pasted', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'image-preview',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 20,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toMatch('engine')
    expect(drawn).not.toMatch('Image #')
    await ui.unmount()
  }
})
