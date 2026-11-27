import { NextResponse } from 'next/server'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { runTick } from '@/lib/auto-outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Called by the open dashboard every ~20 seconds while Auto Apply is ON.
// The server decides whether anything is due (switch, lock, daily limit, 2-5 minute gap).
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  try {
    return NextResponse.json(await runTick(user))
  } catch (error) {
    console.error('[auto-apply] tick route error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Auto Apply step failed' }, { status: 500 })
  }
}
