import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { EncryptionKeyError, encrypt } from '@/lib/crypto'
import { getMaskedKeys, isAiProvider } from '@/lib/user-keys'

export const dynamic = 'force-dynamic'

// GET: which keys are saved (last 4 characters only, never the key itself).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  return NextResponse.json(await getMaskedKeys(user.id), { headers: { 'Cache-Control': 'no-store' } })
}

const FIELDS = { placesKey: 'placesKeyEnc', anthropicKey: 'anthropicKeyEnc', geminiKey: 'geminiKeyEnc' } as const

/**
 * PUT { aiProvider?, placesKey?, anthropicKey?, geminiKey? }
 * A non-empty string saves (encrypted) that key, null removes it, a missing field keeps it.
 */
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))

  const data: Record<string, string | null> = {}
  if (body.aiProvider !== undefined) {
    if (!isAiProvider(body.aiProvider)) return NextResponse.json({ error: 'AI provider must be anthropic or gemini.' }, { status: 400 })
    data.aiProvider = body.aiProvider
  }
  try {
    for (const [field, column] of Object.entries(FIELDS)) {
      const value = body[field]
      if (value === undefined) continue
      if (value === null) {
        data[column] = null
        continue
      }
      const key = typeof value === 'string' ? value.trim() : ''
      if (!key || key.length > 500 || /\s/.test(key)) {
        return NextResponse.json({ error: 'That API key does not look valid (empty, too long, or contains spaces).' }, { status: 400 })
      }
      data[column] = encrypt(key)
    }
  } catch (error) {
    if (error instanceof EncryptionKeyError) return NextResponse.json({ error: error.message }, { status: 503 })
    throw error
  }

  if (Object.keys(data).length) {
    await prisma.userApiKeys.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } })
  }
  return NextResponse.json({ success: true, ...(await getMaskedKeys(user.id)) })
}
