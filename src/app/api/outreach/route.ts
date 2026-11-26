import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentUser, unauthorized } from '@/lib/session'
import { getGoogleAccount, isGmailConnected } from '@/lib/gmail'
import { OUTREACH_DAILY_LIMIT, aiConfigured, getPdfResume, placesConfigured, sentInLastDay } from '@/lib/outreach'

export const dynamic = 'force-dynamic'

// Everything the outreach page needs in one call.
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return unauthorized()
    const [companies, sentLast24h, resume, account] = await Promise.all([
      prisma.outreachCompany.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, website: true, city: true, email: true, emailSource: true, status: true,
          subject: true, body: true, draftedAt: true, approvedAt: true, sentAt: true, error: true, createdAt: true,
        },
      }),
      sentInLastDay(user.id),
      getPdfResume(user.id),
      getGoogleAccount(user.id),
    ])
    return NextResponse.json({
      companies,
      sentLast24h,
      dailyLimit: OUTREACH_DAILY_LIMIT,
      resume: resume ? { fileName: resume.fileName } : null,
      githubUrl: user.githubUrl,
      portfolioUrl: user.portfolioUrl,
      gmailConnected: isGmailConnected(account),
      placesConfigured: placesConfigured(),
      aiConfigured: aiConfigured(),
    })
  } catch (error) {
    console.error('[outreach] list error:', error)
    return NextResponse.json({ error: 'Failed to load outreach data' }, { status: 500 })
  }
}

const isHttpUrl = (v: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}

// Save the GitHub link used in outreach emails.
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  if (typeof body.githubUrl !== 'string') return NextResponse.json({ error: 'githubUrl is required' }, { status: 400 })
  const githubUrl = body.githubUrl.trim()
  if (githubUrl && !isHttpUrl(githubUrl)) return NextResponse.json({ error: 'Enter a full URL, e.g. https://github.com/you' }, { status: 400 })
  await prisma.user.update({ where: { id: user.id }, data: { githubUrl: githubUrl || null } })
  return NextResponse.json({ success: true, githubUrl: githubUrl || null })
}
