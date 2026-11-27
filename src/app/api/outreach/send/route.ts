import { NextResponse } from 'next/server'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { sendApprovedEmails } from '@/lib/outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Send every approved draft from the user's Gmail (resume PDF attached),
// at most 20 per 24 hours and never twice to the same address.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  try {
    const result = await sendApprovedEmails(user)
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  } catch (error) {
    console.error('[outreach] send error:', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Sending failed' }, { status: 500 })
  }
}
