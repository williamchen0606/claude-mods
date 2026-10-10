import { redact } from './redact'

/** The tools clef-guard can check. */
export const TOOLS = ['Bash', 'Write', 'Edit', 'WebFetch'] as const
export type GuardedTool = (typeof TOOLS)[number]

/** The tools named in the `tools` setting (comma-separated); all of them when it names none. */
export function toolsOf(value: unknown): GuardedTool[] {
  const named = typeof value === 'string' ? value.split(',').map(name => name.trim().toLowerCase()) : []
  const tools = TOOLS.filter(tool => named.includes(tool.toLowerCase()))
  return tools.length ? tools : [...TOOLS]
}

/** One tool call, as clef-guard reads it. */
export type Action =
  | { tool: 'Bash'; command: string }
  | { tool: 'Write'; path: string; content: string }
  | { tool: 'Edit'; path: string; oldText: string; newText: string; replaceAll: boolean }
  | { tool: 'WebFetch'; url: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The action a call of `tool` with `input` takes; undefined for a tool or an input clef-guard does not read. */
export function actionOf(tool: string, input: unknown): Action | undefined {
  if (!isRecord(input)) return undefined
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  switch (tool) {
    case 'Bash': {
      const command = text('command')
      return command?.trim() ? { tool, command } : undefined
    }
    case 'Write': {
      const path = text('file_path')
      return path ? { tool, path, content: text('content') ?? '' } : undefined
    }
    case 'Edit': {
      const path = text('file_path')
      return path ? { tool, path, oldText: text('old_string') ?? '', newText: text('new_string') ?? '', replaceAll: input.replace_all === true } : undefined
    }
    case 'WebFetch': {
      const url = text('url')
      return url ? { tool, url } : undefined
    }
    default:
      return undefined
  }
}

/** Where the action runs, and what the person asked for lately. */
export type Context = {
  /** The project's root, absolute. */
  root?: string
  /** The home directory, absolute. */
  home?: string
  /** The person's latest prompts, oldest first; empty when they are not sent. */
  requests: string[]
}

/** How much of a file's text, and of each request, goes to Clef. */
const CONTENT_CHARS = 2_000
const EDIT_CHARS = 1_000
const REQUEST_CHARS = 800

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

function under(path: string, dir: string | undefined): string | undefined {
  if (!dir) return undefined
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return path === base ? '' : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
}

/** `path` as Clef and the dialog see it: relative to the project, else under `~`, else as given. */
export function placeOf(path: string, context: Pick<Context, 'root' | 'home'>): { path: string; insideProject: boolean } {
  const inProject = under(path, context.root)
  if (inProject !== undefined) return { path: `./${inProject}`, insideProject: true }
  const inHome = under(path, context.home)
  if (inHome !== undefined) return { path: `~/${inHome}`, insideProject: false }
  return { path, insideProject: false }
}

/** The `state` sent to Clef for `action`: the action's own fields, redacted and clipped, and the requests. */
export function stateOf(action: Action, context: Context): Record<string, unknown> {
  let state: Record<string, unknown>
  switch (action.tool) {
    case 'Bash':
      state = { tool: 'Bash', command: redact(action.command) }
      break
    case 'Write': {
      const place = placeOf(action.path, context)
      state = { tool: 'Write', path: place.path, inside_project: place.insideProject, content: redact(clip(action.content, CONTENT_CHARS)) }
      break
    }
    case 'Edit': {
      const place = placeOf(action.path, context)
      state = {
        tool: 'Edit',
        path: place.path,
        inside_project: place.insideProject,
        replace: redact(clip(action.oldText, EDIT_CHARS)),
        with: redact(clip(action.newText, EDIT_CHARS)),
        replace_all: action.replaceAll,
      }
      break
    }
    case 'WebFetch':
      state = { tool: 'WebFetch', url: redact(action.url) }
      break
  }
  if (context.requests.length) state.recent_requests = context.requests.map(request => redact(clip(request, REQUEST_CHARS)))
  return state
}

/** How much of the action the dialog shows. */
const SHOWN_CHARS = 300

/** The action as the dialog shows it. */
export function shownOf(action: Action, context: Pick<Context, 'root' | 'home'>): string {
  let shown: string
  switch (action.tool) {
    case 'Bash':
      shown = action.command
      break
    case 'Write':
      shown = `寫入 ${placeOf(action.path, context).path}（${action.content.split('\n').length} 行）`
      break
    case 'Edit':
      shown = `修改 ${placeOf(action.path, context).path}${action.replaceAll ? '（全部取代）' : ''}`
      break
    case 'WebFetch':
      shown = `讀取網址 ${action.url}`
      break
  }
  return clip(shown, SHOWN_CHARS)
}
