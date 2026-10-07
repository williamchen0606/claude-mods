import type { RenderElement } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  buildError,
  captureError,
  fitCells,
  imageIds,
  parseCapture,
  parseEdit,
  pasteReason,
  removeImageTag,
} from '../hooks/preview'

describe('imageIds', () => {
  test('lists each placeholder once, in order', () => {
    expect(imageIds('look [Image #2] and [Image #1] vs [Image #2]')).toEqual([2, 1])
  })

  test('ignores text that is not a placeholder', () => {
    expect(imageIds('[Image #] [image #3] Image #4')).toEqual([])
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
    // A file read before Claude Code finished writing it: path but no size.
    expect(parseCapture('/tmp/claude-0/p/s/images/1.png ')).toBeNull()
  })
})

test('captureError names a missing image', () => {
  expect(captureError(11)).toBe('找不到 Claude Code 存下的圖片')
  expect(captureError(99)).toMatch('99')
})

describe('removeImageTag', () => {
  test('takes out every copy of that placeholder and only that one', () => {
    expect(removeImageTag('a [Image #1] b [Image #12] [Image #1]', 1)).toBe('a  b [Image #12] ')
  })
})

describe('parseEdit', () => {
  test('reads the terminal pid after a save', () => {
    expect(parseEdit('saved 4321\n')).toEqual({ saved: true, terminal: 4321 })
  })

  test('treats a skip or no output as nothing saved', () => {
    expect(parseEdit('skipped\n')).toEqual({ saved: false })
    expect(parseEdit('')).toEqual({ saved: false })
  })
})

test('pasteReason names why the image was not pasted', () => {
  expect(pasteReason('copied untrusted trusted=false target=x')).toBe('沒有輔助使用權限')
  expect(pasteReason('copied not-front front=y trusted=true')).toBe('無法切回終端機')
  expect(pasteReason('')).toBe('無法自動貼上')
})

test('buildError explains a missing swiftc', () => {
  expect(buildError(21)).toMatch('xcode-select --install')
  expect(buildError(null)).toMatch('null')
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
