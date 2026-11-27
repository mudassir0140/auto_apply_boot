import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

/**
 * AES-256-GCM for secrets stored in the database (users' API keys).
 * ENCRYPTION_KEY = 32 random bytes as 64 hex characters (or base64). Generate:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Changing it makes every stored key unreadable (users must save them again).
 * Stored format: v1.<iv>.<auth tag>.<ciphertext>, each part base64url.
 */

export class EncryptionKeyError extends Error {
  constructor(message = 'The server is missing ENCRYPTION_KEY (64 hex characters). Add it to the environment variables and redeploy.') {
    super(message)
    this.name = 'EncryptionKeyError'
  }
}

function getKey(): Buffer {
  const raw = (process.env.ENCRYPTION_KEY || '').trim().replace(/^["']+|["']+$/g, '')
  if (!raw) throw new EncryptionKeyError()
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new EncryptionKeyError('ENCRYPTION_KEY must be 32 bytes: 64 hex characters (or 44 base64 characters).')
  return key
}

export function encryptionConfigured(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

/** Returns null when the value cannot be decrypted (tampered, or ENCRYPTION_KEY changed). */
export function decrypt(stored: string): string | null {
  const [version, iv, tag, data] = stored.split('.')
  if (version !== 'v1' || !iv || !tag || data === undefined) return null
  const key = getKey()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
