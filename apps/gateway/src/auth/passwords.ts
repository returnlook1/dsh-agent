/**
 * 密码哈希：scrypt(N=16384, r=8, p=1)，每个密码独立盐。
 *
 * 存储格式：`scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>`
 * 校验使用 `timingSafeEqual`；登录失败路径会执行一次等价开销的假校验，
 * 以减少用户名是否存在造成的时间差。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  })
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

interface ParsedHash {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (rawN === undefined || rawR === undefined || rawP === undefined || rawSalt === undefined || rawHash === undefined) {
    return undefined
  }
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined
  try {
    const salt = Buffer.from(rawSalt, 'base64url')
    const hash = Buffer.from(rawHash, 'base64url')
    if (salt.length === 0 || hash.length === 0) return undefined
    return { n, r, p, salt, hash }
  } catch {
    return undefined
  }
}

/** 校验失败（含哈希格式损坏）一律返回 false，不抛异常。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseHash(stored)
  if (parsed === undefined) return false
  try {
    const derived = scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: 64 * 1024 * 1024,
    })
    return timingSafeEqual(derived, parsed.hash)
  } catch {
    return false
  }
}

/**
 * 登录失败路径的恒定开销占位校验（账号不存在时也执行一次 scrypt）。
 * 随机盐保证结果必然为 false，且不泄露任何信息。
 */
export function fakeVerifyPassword(password: string): void {
  try {
    scryptSync(password, randomBytes(SALT_LENGTH), KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    })
  } catch {
    // 占位校验不应影响登录流程。
  }
}
