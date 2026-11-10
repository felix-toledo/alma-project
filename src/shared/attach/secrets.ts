// Names that usually hold credentials (spec 030 BR-20), matched per segment so a folder called `.env` counts too (G13).
const SECRET_NAME =
  /^(\.env.*|\.npmrc|\.netrc|.*\.(pem|key|pfx|ppk|kdbx)|id_rsa.*|id_ed25519.*|passwords\..*|credentials.*|login data|cookies)$/i

/** A warning, never a refusal: the name (and the path, when the page knows it) looks like it holds a secret. */
export function isSecretLikeName(name: string, path?: string): boolean {
  return `${path ?? ''}/${name}`.split(/[\\/]/).some((segment) => SECRET_NAME.test(segment))
}

const MASK = '[masked]'

// The families of `redact()` in shared/audit (which is node-only and unchanged) plus the ones BR-20 adds.
// Best effort: a quoted JSON key (`"password": "x"`) and any format not listed here pass through (RISKS.md).
const MASKS: [RegExp, string][] = [
  // an opener without its closer (a truncated file) masks to the end of the text, so the scan never restarts
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g, MASK],
  [/\b(?:xai|sk|LLM)[-|][\w-]{16,}/g, MASK],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\b(pass(?:word|wd)?|token|secret|api[_-]?key)(\s*[=:]\s*)(?!\[masked\])\S+/gi, `$1$2${MASK}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, MASK],
  [/\bAIza[\w-]{35}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
]

/** Replaces secret-looking values in text read from an attachment and says how many (AC-3.5). Pixels are never scanned. */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0
  let out = text
  for (const [pattern, replacement] of MASKS) {
    out = out.replace(pattern, (...match) => {
      masked += 1
      // `replace` with a function does not expand `$1`, so the groups are put back by hand
      return replacement.replace(/\$(\d)/g, (_, n) => String(match[Number(n)] ?? ''))
    })
  }
  return { text: out, masked }
}
