/**
 * Rules clef-guard settles on the machine, without Clef: the operations that
 * always go to the person, and the commands too plainly read-only to send.
 *
 * The shell parsing here is deliberately rough. It reads quotes, operators,
 * command substitution and the common wrappers (`sudo`, `env`, `xargs`,
 * `sh -c`), which covers what a coding agent writes; Clef is the backstop for
 * the rest.
 */

/**
 * The simple commands in `command`, each as its words with quotes removed:
 * split on `;`, `&&`, `||`, `|`, `&`, newlines, parentheses and command
 * substitution, and with `#` comments dropped.
 */
export function segments(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close < 0 ? command.length : close
      word += command.slice(i + 1, end)
      inWord = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j++
        word += command[j]
        j++
      }
      inWord = true
      i = j
    } else if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') {
        word += command[i + 1]
        inWord = true
      }
      i++
    } else if (c === '#' && !inWord) {
      const newline = command.indexOf('\n', i)
      i = newline < 0 ? command.length : newline - 1
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === ';' || c === '\n' || c === '|' || c === '(' || c === ')' || c === '`') {
      endSegment()
    } else if (c === '&') {
      // `2>&1` and `&>` are redirections, not operators.
      if (command[i - 1] === '>' || command[i + 1] === '>') {
        word += c
        inWord = true
      } else endSegment()
    } else if (c === '$' && command[i + 1] === '(') {
      endSegment()
      i++
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()

  // A substitution inside double quotes stayed in its word; read it as its own command too.
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = match[1] ?? match[2] ?? ''
    if (inner.trim() && inner !== command) out.push(...segments(inner))
  }
  return out
}

/** Wrappers that run the command after them, with the options of theirs that take a value. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nohup: [],
  time: [],
  nice: ['-n'],
  ionice: ['-c', '-n'],
  command: [],
  builtin: [],
  exec: ['-a'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'],
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/**
 * Every command `command` runs, as its words with the program's basename
 * first: wrappers and leading `NAME=value` assignments stripped, and the
 * script of `sh -c` and `eval` read as commands of their own.
 */
export function commandsOf(command: string, depth = 0): string[][] {
  const out: string[][] = []
  for (const segment of segments(command)) {
    let words = segment
    for (;;) {
      while (words.length && ASSIGNMENT.test(words[0]!)) words = words.slice(1)
      const program = words[0] === undefined ? undefined : basename(words[0])
      const takesValue = program === undefined ? undefined : WRAPPERS[program]
      if (!takesValue) break
      let i = 1
      while (i < words.length && (words[i]!.startsWith('-') || (program === 'env' && ASSIGNMENT.test(words[i]!)))) {
        i += takesValue.includes(words[i]!) ? 2 : 1
      }
      // timeout's first operand is the duration.
      if (program === 'timeout') i++
      words = words.slice(i)
    }
    if (!words.length) continue
    const program = basename(words[0]!)
    words = [program, ...words.slice(1)]

    if (depth < 3 && SHELLS.has(program)) {
      const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word))
      const script = flag > 0 ? words[flag + 1] : undefined
      if (script !== undefined) {
        out.push(words, ...commandsOf(script, depth + 1))
        continue
      }
    }
    if (depth < 3 && program === 'eval') {
      out.push(words, ...commandsOf(words.slice(1).join(' '), depth + 1))
      continue
    }
    out.push(words)
  }
  return out
}

/** Whether `words` (a command from `commandsOf`) carries a short flag holding `letter`, like `-rf`, or a long one in `long`. */
function hasFlag(words: string[], letter: RegExp, long: string[]): boolean {
  return words.slice(1).some(word => long.includes(word) || (/^-[^-]/.test(word) && letter.test(word.slice(1))))
}

/** Why `words` must go to the person, from the built-in rules; undefined when none applies. */
function builtIn(words: string[]): string | undefined {
  const [program, ...args] = words
  switch (program) {
    case 'rm': {
      const operands = args.filter(word => !word.startsWith('-'))
      if (operands.some(word => /(^|\/)\.git\/?$/.test(word))) return '刪除 git repo（.git）'
      if (hasFlag(words, /[rR]/, ['--recursive'])) return 'rm -r（遞迴刪除）'
      return undefined
    }
    case 'gh': {
      if (args[0] === 'repo' && args[1] === 'delete') return '刪除 GitHub repo'
      if (args[0] === 'api') {
        const method = args.findIndex(word => word === '-X' || word === '--method')
        const deletes =
          (method >= 0 && args[method + 1]?.toUpperCase() === 'DELETE') || args.some(word => /^(-XDELETE|--method=DELETE)$/i.test(word))
        if (deletes && args.some(word => /^\/?repos\/[^/]+\/[^/]+\/?$/.test(word))) return '刪除 GitHub repo'
      }
      return undefined
    }
    case 'git': {
      let i = 0
      while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!) ? 2 : 1
      if (args[i] !== 'push') return undefined
      const rest = ['push', ...args.slice(i + 1)]
      if (hasFlag(rest, /f/, ['--force', '--mirror']) || rest.some(word => word.startsWith('--force-with-lease') || /^\+[^+]/.test(word))) {
        return 'git push --force（強制推送）'
      }
      if (hasFlag(rest, /d/, ['--delete']) || rest.some(word => /^:[^:]/.test(word))) return '刪除遠端分支或 tag'
      return undefined
    }
    case 'dd':
      return args.some(word => word.startsWith('of=/dev/')) ? '抹除磁碟' : undefined
    case 'wipefs':
    case 'shred':
      return '抹除磁碟或檔案'
    default:
      return program?.startsWith('mkfs') ? '抹除磁碟' : undefined
  }
}

/** The command prefixes in the `alwaysAsk` setting: comma-separated, each split into words. */
export function prefixesOf(value: unknown): string[][] {
  if (typeof value !== 'string') return []
  return value
    .split(/[,\n]/)
    .map(prefix => prefix.trim().split(/\s+/).filter(Boolean))
    .filter(words => words.length > 0)
}

/**
 * Why `command` must go to the person whatever Clef says, or undefined: the
 * built-in rules (recursive `rm`, deleting a git repository, force-pushing or
 * deleting remote branches, wiping disks) and the prefixes the person added.
 */
export function mustAsk(command: string, prefixes: string[][] = []): string | undefined {
  for (const words of commandsOf(command)) {
    const rule = builtIn(words)
    if (rule) return rule
    for (const prefix of prefixes) {
      const head = [basename(prefix[0]!), ...prefix.slice(1)]
      if (head.every((word, i) => words[i] === word)) return `你設定的「${prefix.join(' ')}」`
    }
  }
  return undefined
}

/** Programs that only read, with the options that would make them write or run something. */
const READ_ONLY: Record<string, string[]> = {
  ls: [],
  pwd: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  grep: [],
  rg: ['--pre', '--pre-glob'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  echo: [],
  which: [],
  file: [],
  stat: [],
  du: [],
  df: [],
  uname: [],
  whoami: [],
  realpath: [],
  basename: [],
  dirname: [],
}

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse'])

/**
 * Whether `command` is one plain read-only command (`ls`, `cat`, `grep`,
 * `git status`, ...) with no redirection, pipe, substitution or variable, so
 * there is nothing for Clef to judge.
 */
export function obviouslyReadOnly(command: string): boolean {
  if (/[;&|<>`$(){}\n\\]/.test(command)) return false
  const all = segments(command)
  if (all.length !== 1) return false
  const [program, ...args] = all[0]!
  if (program === 'git') {
    return READ_ONLY_GIT.has(args[0] ?? '') && !args.some(word => word.startsWith('--output') || word === '--ext-diff')
  }
  const refused = program === undefined ? undefined : READ_ONLY[program]
  return refused !== undefined && !args.some(word => refused.some(option => word === option || word.startsWith(`${option}=`)))
}
