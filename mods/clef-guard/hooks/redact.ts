const MASK = '<redacted>'

const SECRET_PATTERNS: [RegExp, string][] = [
  // Authorization headers and bearer tokens.
  [/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s'"]+/gi, `$1${MASK}`],
  [/(bearer\s+)[^\s'"]+/gi, `$1${MASK}`],
  // NAME=value where the name says it holds a secret.
  [/(\b[\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi, `$1${MASK}`],
  // --password value, --token=value, ...
  [/(--?(?:password|passwd|pass|token|secret|api-?key|auth|key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s'"-][^\s'"]*)/gi, `$1${MASK}`],
  // user:password@ in URLs.
  [/(\w+:\/\/)[^\s/@'"]+@/g, `$1${MASK}@`],
  // Well-known token formats.
  [/\b(?:sk|pk|rk)-[\w-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_\w{20,}/g, MASK],
  [/\bxox[abprs]-[\w-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
]

/** Long opaque runs of letters and digits, which are usually keys. */
const OPAQUE = /[A-Za-z0-9+/_=-]{40,}/g

/**
 * Masks what looks like a credential in a command before it leaves the
 * machine. A heuristic: it errs on masking, since Clef needs the shape of the
 * command, not its secrets.
 */
export function redact(command: string): string {
  let out = command
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out.replace(OPAQUE, run => (/[A-Za-z]/.test(run) && /[0-9]/.test(run) ? MASK : run))
}
