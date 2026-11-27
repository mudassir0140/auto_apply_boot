import '@/lib/normalize-env'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Which env vars are set (true/false only, never values), whether the database
// answers, and whether the NextAuth config loads. Public on purpose: it is the
// first thing to open when sign-in fails on a deployment.
const ENV_VARS = ['DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ENCRYPTION_KEY'] as const

// Error text can quote the connection string; never echo credentials back.
function safeMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text
    .replace(/mongodb(\+srv)?:\/\/[^\s"'`]+/gi, 'mongodb$1://<redacted>')
    .replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, 'postgres$1://<redacted>')
    .trim()
    .slice(0, 2000)
}

async function checkDatabase(): Promise<string> {
  try {
    const { prisma } = await import('@/lib/prisma')
    await prisma.user.count()
    return 'ok'
  } catch (error) {
    return safeMessage(error)
  }
}

async function checkAuth(): Promise<string> {
  try {
    const { authOptions } = await import('@/lib/auth')
    // The same things NextAuth itself needs, so a failure here is the reason
    // /api/auth/* would answer 500 (or Google would reject the sign-in).
    if (!authOptions.secret) throw new Error('NEXTAUTH_SECRET is not set: NextAuth answers every /api/auth/* request with 500 (NO_SECRET).')
    const google = authOptions.providers.find((p) => p.id === 'google') as { options?: { clientId?: string; clientSecret?: string } } | undefined
    if (!google) throw new Error('The Google provider is not configured.')
    if (!google.options?.clientId) throw new Error('GOOGLE_CLIENT_ID is not set: Google rejects the sign-in (invalid_client).')
    if (!google.options?.clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not set: Google rejects the sign-in.')
    if (!process.env.NEXTAUTH_URL) throw new Error('NEXTAUTH_URL is not set or not a valid URL.')
    return 'ok'
  } catch (error) {
    return safeMessage(error)
  }
}

export async function GET() {
  const env = Object.fromEntries(ENV_VARS.map((name) => [name, !!process.env[name]?.trim()]))
  const [database, auth] = await Promise.all([checkDatabase(), checkAuth()])
  return NextResponse.json(
    { ok: database === 'ok' && auth === 'ok', env, database, auth, deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
