/**
 * Redaction / truncation / digest contract (docs/IMPL-PLUGINS.md §4).
 */
import { describe, expect, it } from 'vitest'

import {
  argumentsDigest,
  argumentsPreview,
  canonicalJson,
  isSensitiveKey,
  MAX_ARGUMENTS_PREVIEW,
  redactValue,
  REDACTED,
} from './redact.js'

describe('isSensitiveKey', () => {
  it('redacts token / secret / password / authorization keys in any casing', () => {
    for (const key of ['token', 'apiToken', 'ACCESS_TOKEN', 'clientSecret', 'password', 'Authorization', 'authtoken']) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('redacts whole-word key segments', () => {
    for (const key of ['key', 'apiKey', 'api_key', 'private-key', 'ACCESS_KEY_ID']) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('keeps ordinary business arguments intact', () => {
    for (const key of ['keyword', 'monkey', 'days', 'stationId', 'format']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })
})

describe('redactValue', () => {
  it('redacts nested sensitive keys and keeps the shape', () => {
    const redacted = redactValue({
      stationId: 'ST-001',
      days: 3,
      nested: { password: 'hunter2', keep: 'yes' },
      headers: [{ authorization: 'Bearer abc' }],
    })
    expect(redacted).toEqual({
      stationId: 'ST-001',
      days: 3,
      nested: { password: REDACTED, keep: 'yes' },
      headers: [{ authorization: REDACTED }],
    })
  })

  it('never leaks the secret value into the JSON form', () => {
    const text = JSON.stringify(redactValue({ api_key: 'super-secret-value' }))
    expect(text).not.toContain('super-secret-value')
    expect(text).toContain(REDACTED)
  })

  it('survives cycles without throwing', () => {
    const value: Record<string, unknown> = { name: 'x' }
    value['self'] = value
    expect(() => redactValue(value)).not.toThrow()
  })
})

describe('argumentsPreview', () => {
  it('truncates to 300 characters and stays on one line', () => {
    const preview = argumentsPreview({ blob: 'x'.repeat(5000) })
    expect(preview.length).toBeLessThanOrEqual(MAX_ARGUMENTS_PREVIEW)
    expect(preview).not.toContain('\n')
    expect(preview.endsWith('…')).toBe(true)
  })

  it('keeps short arguments verbatim', () => {
    expect(argumentsPreview({ stationId: 'ST-001', days: 7 })).toBe('{"stationId":"ST-001","days":7}')
  })
})

describe('argumentsDigest', () => {
  it('is insensitive to key order', () => {
    expect(argumentsDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(argumentsDigest({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('changes when a value changes', () => {
    expect(argumentsDigest({ stationId: 'ST-001' })).not.toBe(argumentsDigest({ stationId: 'ST-002' }))
  })

  it('is a 64 character sha256 hex string', () => {
    expect(argumentsDigest({ days: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not hash the raw secret', () => {
    // The digest is taken over the redacted form, so two different secrets collide
    // by design — the approval is per-call, and the secret never leaves the process.
    expect(argumentsDigest({ token: 'aaa' })).toBe(argumentsDigest({ token: 'bbb' }))
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })
})
