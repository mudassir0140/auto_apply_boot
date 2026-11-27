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

const open = (stored: string | null | undefined): string | null => (stored ? decrypt(stored) : null)

function mask(stored: string | null | undefined): MaskedKey {
  if (!stored) return { set: false, last4: null }
  const plain = encryptionConfigured() ? decrypt(stored) : null
  if (!plain) return { set: true, last4: null, unreadable: true }
  return { set: true, last4: plain.slice(-4) }
}

/** The user's decrypted keys, for server-side use only. */
export async function getUserKeys(userId: string): Promise<UserKeys> {
  const row = await prisma.userApiKeys.findUnique({ where: { userId } })
  const aiProvider: AiProvider = isAiProvider(row?.aiProvider) ? row!.aiProvider as AiProvider : 'anthropic'
  if (!row || !encryptionConfigured()) return { placesKey: null, aiProvider, aiKey: null }
  return {
    placesKey: open(row.placesKeyEnc),
    aiProvider,
    aiKey: open(aiProvider === 'gemini' ? row.geminiKeyEnc : row.anthropicKeyEnc),
  }
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
