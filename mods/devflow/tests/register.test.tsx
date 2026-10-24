import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'devflow',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const progress = {
  track: 'bug',
  size: 'S',
  task: 'slugify strips edge hyphens',
  stages: [
    { name: 'diagnose', status: 'done' },
    { name: 'tdd', status: 'active', note: 'slice 1/1' },
    { name: 'prove', status: 'pending' },
    { name: 'ship', status: 'pending' },
  ],
}

test('the band draws the route below what the engine draws, on the terminal and the desktop', async ($, on) => {
  on('state.get', (_, e) => ({ value: e.key === 'progress' ? { value: progress, version: 1 } : { value: undefined, version: 0 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect((await ui.find({ type: 'Text', text: /^tdd ●$/ }))?.text).toBe('tdd ●')
    expect((await ui.find({ type: 'Text', text: /slice 1\/1/ }))?.text).toBe('tdd：slice 1/1 · slugify strips edge hyphens')
    await ui.unmount()
  }
})

test('with no progress file the band leaves the drawing to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /devflow/ })).toBeUndefined()
  await ui.unmount()
})

test('the hide button records that the band is hidden', async ($, on) => {
  // A store of the test's own, so the press's write can be read back.
  const held = new Map<string, { value: unknown; version: number }>([['progress', { value: progress, version: 1 }]])
  on('state.get', (_, e) => ({ value: held.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (held.get(e.key)?.version ?? 0) + 1
    held.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /devflow · bug/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(held.get('isHidden')?.value).toBe(true)
  await ui.unmount()
})

test('a hidden band leaves the drawing to the engine', async ($, on) => {
  on('state.get', (_, e) => ({
    value: e.key === 'progress' ? { value: progress, version: 1 } : e.key === 'isHidden' ? { value: true, version: 1 } : { value: undefined, version: 0 },
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /devflow/ })).toBeUndefined()
  await ui.unmount()
})
