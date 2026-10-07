// The surface module laid over each picture on macOS: draws nothing, and
// posts `{ open: <id> }` to the hooks module when the picture is clicked.

import type { ClientModule } from 'claude-code'

const Click: ClientModule<{ id: number }, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(e => {
      if (e.type === 'down' && e.button === 'left') surface.post({ open: props.id })
    })
    surface.setState(true)
  }
  const { Box } = surface.elements
  return <Box width={surface.columns} height={surface.rows} />
}

export default Click
