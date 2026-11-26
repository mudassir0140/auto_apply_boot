import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentUser, isObjectId, unauthorized } from '@/lib/session'
import { alreadyEmailed } from '@/lib/outreach'

export const dynamic = 'force-dynamic'

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i

/**
 * Edit / approve one draft.
 * body: { subject?, body?, email?, action?: 'save' | 'approve' | 'unapprove' | 'skip' }
 * Sent (or sending) emails can no longer be changed.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  if (!isObjectId(params.id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const company = await prisma.outreachCompany.findFirst({ where: { id: params.id, userId: user.id } })
  if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (company.status === 'sent' || company.status === 'sending') {
    return NextResponse.json({ error: 'This email was already sent and cannot be changed.' }, { status: 409 })
  }

  const input = await req.json().catch(() => ({}))
  const action: string = input.action || 'save'
  const subject = typeof input.subject === 'string' ? input.subject.trim().slice(0, 200) : company.subject
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trim().slice(0, 10_000) : company.body
  let email = company.email
  if (typeof input.email === 'string') {
    const value = input.email.trim().toLowerCase()
    if (value && !EMAIL.test(value)) return NextResponse.json({ error: 'That email address is not valid.' }, { status: 400 })
    email = value || null
  }

  let status = company.status
  let approvedAt = company.approvedAt
  if (action === 'approve') {
    if (!email) return NextResponse.json({ error: 'Add an email address before approving.' }, { status: 400 })
    if (!subject || !body) return NextResponse.json({ error: 'Write a subject and body before approving.' }, { status: 400 })
    const previous = await alreadyEmailed(user.id, email, company.id)
    if (previous) {
      return NextResponse.json({ error: `${email} was already emailed on ${previous.toISOString().slice(0, 10)}. The same address is never emailed twice.` }, { status: 409 })
    }
    status = 'approved'
    approvedAt = new Date()
  } else if (action === 'unapprove') {
    status = 'pending'
    approvedAt = null
  } else if (action === 'skip') {
    status = 'skipped'
    approvedAt = null
  } else if (action === 'save') {
    // Editing a failed / skipped / no-email row puts it back in the review queue.
    if (status !== 'approved') status = email ? 'pending' : 'no_email'
  } else {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const updated = await prisma.outreachCompany.update({
    where: { id: company.id },
    data: { subject, body, email, status, approvedAt, ...(action === 'skip' ? {} : { error: null }) },
    select: { id: true, status: true, subject: true, body: true, email: true, approvedAt: true, error: true },
  })
  return NextResponse.json({ success: true, company: updated })
}
