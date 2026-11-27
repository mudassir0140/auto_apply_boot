import { prisma } from './prisma'
import { decrypt, encryptionConfigured } from './crypto'

export type AiProvider = 'anthropic' | 'gemini'
export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'gemini']
export const isAiProvider = (v: unknown): v is AiProvider => v === 'anthropic' || v === 'gemini'

export interface UserKeys {
  placesKey: string | null
  aiProvider: AiProvider
  aiKey: string | null // key of the selected provider
}

/** What the browser may see: whether each key is set and its last 4 characters. */
export interface MaskedKey {
  set: boolean
  last4: string | null
  unreadable?: boolean // stored, but cannot be decrypted (ENCRYPTION_KEY changed)
}

function mask(stored: string | null | undefined): MaskedKey {
  if (!stored) return { set: false, last4: null }
  const plain = encryptionConfigured() ? decrypt(stored) : null
  if (!plain) return { set: true, last4: null, unreadable: true }
  return { set: true, last4: plain.slice(-4) }
}

const readEnv = (name: string): string | null => process.env[name]?.trim().replace(/^["']+|["']+$/g, '').trim() || null

/**
 * The API keys outreach and Auto Apply use, for server-side use only.
 * They come from the server environment (GOOGLE_PLACES_API_KEY, GEMINI_API_KEY), not from
 * the user: Gemini is the only AI provider. Keys users saved earlier (UserApiKeys) are kept
 * in the database but no longer used. `userId` is kept so callers do not change.
 */
export async function getUserKeys(_userId?: string): Promise<UserKeys> {
  return {
    placesKey: readEnv('GOOGLE_PLACES_API_KEY'),
    aiProvider: 'gemini',
    aiKey: readEnv('GEMINI_API_KEY'),
  }
}

/** Server keys that are missing, by env var name (for server logs only). */
export function missingServerKeys(): string[] {
  return ['GOOGLE_PLACES_API_KEY', 'GEMINI_API_KEY'].filter((name) => !readEnv(name))
}

export async function getMaskedKeys(userId: string) {
  const row = await prisma.userApiKeys.findUnique({ where: { userId } })
  return {
    encryptionConfigured: encryptionConfigured(),
    aiProvider: (isAiProvider(row?.aiProvider) ? row!.aiProvider : 'anthropic') as AiProvider,
    places: mask(row?.placesKeyEnc),
    anthropic: mask(row?.anthropicKeyEnc),
    gemini: mask(row?.geminiKeyEnc),
  }
}
