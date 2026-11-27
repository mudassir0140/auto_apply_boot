import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { getStatus, setEnabled } from '@/lib/auto-outreach'

export const dynamic = 'force-dynamic'

// Auto Apply status + records for the dashboard.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  try {
    return NextResponse.json(await getStatus(user))
  } catch (error) {
    console.error('[auto-apply] status error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load Auto Apply' }, { status: 500 })
  }
}

// Turn the switch ON / OFF. Body: { enabled: boolean }
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
  try {
    const result = await setEnabled(user, body.enabled)
    const status = await getStatus(user)
    if (!result.ok) return NextResponse.json({ ...status, error: result.error }, { status: 400 })
    return NextResponse.json(status)
  } catch (error) {
    console.error('[auto-apply] toggle error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not change Auto Apply' }, { status: 500 })
  }
}
