import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentUser, isObjectId, unauthorized } from '@/lib/session'
import { OutreachKeyError, draftEmail, keyErrorBody } from '@/lib/outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH = 10

// Write AI drafts. With `ids`: (re)write those companies' drafts. Without: the next
// BATCH pending companies that have no draft yet. Approved/sent drafts are never touched.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter(isObjectId).slice(0, BATCH) : []

  const companies = await prisma.outreachCompany.findMany({
    where: ids.length
      ? { userId: user.id, id: { in: ids }, status: { in: ['pending', 'failed'] }, email: { not: null } }
      : { userId: user.id, status: 'pending', email: { not: null }, body: null },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })

  let drafted = 0
  const errors: Array<{ id: string; name: string; error: string }> = []
  try {
    for (let i = 0; i < companies.length; i += 3) {
      await Promise.all(
        companies.slice(i, i + 3).map(async (c) => {
          try {
            const draft = await draftEmail(user, c)
            await prisma.outreachCompany.update({ where: { id: c.id }, data: { ...draft, draftedAt: new Date(), error: null } })
            drafted++
          } catch (error) {
            if (error instanceof OutreachKeyError) throw error
            errors.push({ id: c.id, name: c.name, error: error instanceof Error ? error.message : 'Draft failed' })
          }
        })
      )
    }
  } catch (error) {
    // Missing/rejected API key: every draft would fail the same way, so point to Settings.
    if (error instanceof OutreachKeyError) return NextResponse.json({ ...keyErrorBody(error), drafted }, { status: 400 })
    throw error
  }

  const remaining = await prisma.outreachCompany.count({ where: { userId: user.id, status: 'pending', email: { not: null }, body: null } })
  return NextResponse.json({ success: true, drafted, errors, remaining })
}
