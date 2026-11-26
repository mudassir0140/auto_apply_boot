import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { OutreachConfigError, discoverCompanies } from '@/lib/outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Find software houses in a city (Google Places) and read their public email from their website.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const city = typeof body.city === 'string' ? body.city.trim().slice(0, 80) : ''
  const query = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 80) : 'software house'
  if (!city) return NextResponse.json({ error: 'Enter a city.' }, { status: 400 })

  try {
    return NextResponse.json({ success: true, ...(await discoverCompanies(user.id, city, query)) })
  } catch (error) {
    console.error('[outreach] discover error:', error)
    const message = error instanceof Error ? error.message : 'Search failed'
    return NextResponse.json({ error: message }, { status: error instanceof OutreachConfigError ? 503 : 502 })
  }
}
