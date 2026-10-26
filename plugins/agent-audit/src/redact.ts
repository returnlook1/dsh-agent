/**
 * Argument redaction, truncation, canonicalisation and fingerprinting.
 *
 * Shared (by copy) with `plugins/agent-policy`; both plugins are forbidden from
 * importing each other because that would be a runtime import of a second plugin
 * module. Keep this file byte-identical to `plugins/agent-policy/src/redact.ts`.
 *
 * Contract (docs/IMPL-PLUGINS.md, non-negotiable #6):
 * - keys matching `token|secret|password|key|authorization` (case-insensitive)
 *   are redacted;
 * - the stored preview is truncated to 300 characters;
 * - `argumentsDigest` is sha256 over sorted-key canonical JSON.
 */
import { createHash } from 'node:crypto'

/** Upper bound on the stored argument preview, in characters. */
export const MAX_ARGUMENTS_PREVIEW = 300

/** Replacement marker for a redacted value. */
export const REDACTED = '[REDACTED]'

/**
 * Keys that are always redacted on a substring basis.
 *
 * `key` is handled separately (see {@link isSensitiveKey}) so that innocuous
 * arguments such as `keyword` or `monkey` are not destroyed while `apiKey`,
 * `api_key`, `private_key` still are.
 */
const SENSITIVE_SUBSTRINGS = ['token', 'secret', 'password', 'authorization'] as const

/** Split a key into lower-case words: `apiKey` / `api_key` / `API-KEY` → [api, key]. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase())
}

/**
 * Whether one argument key must be redacted.
 *
 * Deviates slightly from a pure substring match on purpose: `key` is matched as a
 * whole word so that a business argument named `keyword` is preserved, while
 * `token` / `secret` / `password` / `authorization` stay substring matches so that
 * `authtoken` or `clientSecret` cannot slip through.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  for (const needle of SENSITIVE_SUBSTRINGS) {
    if (lower.includes(needle)) return true
  }
  return keySegments(key).includes('key')
}

/** Depth guard: arguments are lossless JSON, but never trust that assumption. */
const MAX_DEPTH = 32

/**
 * Deeply replace sensitive values with {@link REDACTED}.
 *
 * Arrays keep their shape (so a redacted array still shows cardinality); plain
 * objects recurse; cycles and over-deep values degrade to a marker instead of
 * throwing, because auditing must never fail on hostile input.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED:depth]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[TRUNCATED:cycle]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen))
  }

  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen)
  }
  return output
}

/**
 * Serialise one value as JSON with object keys sorted at every level.
 *
 * Used as the digest pre-image so that `{a:1,b:2}` and `{b:2,a:1}` fingerprint
 * identically. Non-JSON values (`undefined`, functions) serialise as `null`,
 * matching `JSON.stringify` for array slots and vanishing for object values.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

function canonicalize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED:depth]'
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' || value === undefined ? null : value
  }
  if (seen.has(value)) return '[TRUNCATED:cycle]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1, seen))
  }

  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    output[key] = canonicalize(source[key], depth + 1, seen)
  }
  return output
}

/** Redacted, single-line, ≤300 character preview of one argument object. */
export function argumentsPreview(args: unknown): string {
  const text = JSON.stringify(redactValue(args)) ?? 'null'
  const singleLine = text.replace(/\s+/g, ' ')
  if (singleLine.length <= MAX_ARGUMENTS_PREVIEW) return singleLine
  return `${singleLine.slice(0, MAX_ARGUMENTS_PREVIEW - 1)}…`
}

/**
 * sha256 fingerprint of the redacted arguments in canonical (sorted-key) form.
 *
 * Redacted on purpose: the digest is stored in audit files and approval requests,
 * which are read by the gateway and by operators; hashing the pre-redaction value
 * would fingerprint secrets that the rest of the record carefully removes.
 */
export function argumentsDigest(args: unknown): string {
  return createHash('sha256').update(canonicalJson(redactValue(args)), 'utf8').digest('hex')
}
