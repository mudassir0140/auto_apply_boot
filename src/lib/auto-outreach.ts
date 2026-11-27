import type { OutreachCompany } from '@prisma/client'
import { prisma } from './prisma'
import { parseJsonList, type CurrentUser } from './session'
import { getUserKeys } from './user-keys'
import {
  OutreachKeyError,
  acceptable,
  alreadyEmailed,
  discoverCompanies,
  domainOf,
  draftEmail,
  emailsIn,
  fetchHtml,
  getPdfResume,
  htmlToText,
  rank,
  sameSite,
  OUTREACH_DAILY_LIMIT,
} from './outreach'
import { sendApplicationEmail, GmailApiDisabledError, GmailNotConnectedError, GmailScopeError } from './gmail'

/**
 * Auto Apply: automatic software-house outreach while the user has /dashboard open.
 *
 * The dashboard calls runTick() every ~20 seconds while the switch is ON. Each tick:
 *  - does nothing if the switch is OFF, another tick is running, the daily limit is reached,
 *    or the 2-5 minute gap since the last email has not passed yet;
 *  - otherwise takes the next unhandled software house (finding new ones with the user's
 *    Places key when none are left), checks its careers page for an open job, and
 *    sends at most ONE email from the user's Gmail with their PDF resume attached:
 *      careers page lists a job + an apply email  -> application for that job ("Job applied")
 *      careers page lists a job but only a form   -> saved as "Apply manually" (forms are never filled)
 *      no job, but a public careers/HR email      -> personalised cold email ("Email")
 *  - never emails an address that was emailed before (by Auto Apply, outreach or a job application).
 * Closing the dashboard stops the ticks, so nothing runs while the user is away.
 */

export const AUTO_DAILY_LIMIT = OUTREACH_DAILY_LIMIT // 20
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_GAP_MS = 2 * 60 * 1000
const MAX_GAP_MS = 5 * 60 * 1000
const LOCK_MS = 4 * 60 * 1000
const TICK_BUDGET_MS = 90 * 1000 // stop picking up new companies after this long in one tick
const ACTIVE_MS = 90 * 1000 // a tick within this window = the dashboard is open and running
const SEARCH_PHRASES = ['software house', 'software company', 'IT company', 'web development company', 'mobile app development company']

export type LogType = 'email' | 'job_applied' | 'apply_manually'
export type LogStatus = 'sent' | 'failed' | 'pending'

const randomGap = () => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1))

/** First location from the user's Preferences that is a real place (not "Remote"). */
export function cityOf(user: Pick<CurrentUser, 'jobLocations'>): string | null {
  const city = parseJsonList(user.jobLocations)
    .map((l) => String(l).trim())
    .find((l) => l && !/^(remote|anywhere|worldwide|global|online|work from home|wfh)$/i.test(l))
  return city ? city.slice(0, 80) : null
}

/** Emails Boot sent from this user's Gmail in the last 24 hours (all features), plus any being sent right now. */
export async function sentToday(userId: string) {
  const since = new Date(Date.now() - DAY_MS)
  const [sent, sending, pending] = await Promise.all([
    prisma.sentEmail.count({ where: { userId, sentAt: { gte: since } } }),
    prisma.outreachCompany.count({ where: { userId, status: 'sending' } }),
    prisma.autoOutreachLog.count({ where: { userId, status: 'pending', type: { not: 'apply_manually' }, createdAt: { gte: new Date(Date.now() - LOCK_MS) } } }),
  ])
  return sent + sending + pending
}

async function getState(userId: string) {
  return prisma.autoOutreachState.upsert({ where: { userId }, update: {}, create: { userId } })
}

/** What has to be in place before Auto Apply can run. Returns a message for the first missing piece. */
export async function missingRequirement(user: CurrentUser): Promise<string | null> {
  if (!cityOf(user)) return 'Add your city under Preferences → Job locations (e.g. "Lahore"). Auto Apply searches for software houses there.'
  const keys = await getUserKeys(user.id)
  if (!keys.placesKey) return 'Add your Google Places API key in Settings → API Keys.'
  if (!keys.aiKey) return `Add your ${keys.aiProvider === 'gemini' ? 'Gemini' : 'Anthropic'} API key in Settings → API Keys.`
  if (!(await getPdfResume(user.id))) return 'Upload your resume as a PDF on the Profile page. It is attached to every email.'
  return null
}

export async function getStatus(user: CurrentUser) {
  const [state, count, records] = await Promise.all([
    getState(user.id),
    sentToday(user.id),
    prisma.autoOutreachLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, company: true, website: true, email: true, jobTitle: true, jobUrl: true, type: true, status: true, error: true, createdAt: true, sentAt: true },
    }),
  ])
  return {
    enabled: state.enabled,
    running: state.enabled && !!state.lastTickAt && Date.now() - state.lastTickAt.getTime() < ACTIVE_MS,
    nextSendAt: state.nextSendAt,
    message: state.message,
    city: cityOf(user),
    sentToday: count,
    limit: AUTO_DAILY_LIMIT,
    records,
  }
}

export async function setEnabled(user: CurrentUser, enabled: boolean) {
  if (enabled) {
    const missing = await missingRequirement(user)
    if (missing) {
      await prisma.autoOutreachState.upsert({ where: { userId: user.id }, update: { enabled: false, message: missing }, create: { userId: user.id, message: missing } })
      return { ok: false as const, error: missing }
    }
  }
  await prisma.autoOutreachState.upsert({
    where: { userId: user.id },
    update: { enabled, message: enabled ? 'Starting…' : 'Auto Apply is off.' },
    create: { userId: user.id, enabled, message: enabled ? 'Starting…' : 'Auto Apply is off.' },
  })
  return { ok: true as const }
}

// ---------------------------------------------------------------------------
// Careers page: open job + how to apply
// ---------------------------------------------------------------------------

interface JobPost {
  title: string
  url: string // job posting (or careers page) link
  applyEmail: string | null
}

const LINK_RE = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
const CAREERS_LINK = /career|jobs?\b|vacanc|opening|join[-_ ]?(us|our|the)?[-_ ]?team|hiring|work[-_ ]with[-_ ]us|positions/i
// A job title names a role.
const ROLE_NOUN = /\b(developer|engineer|programmer|designer|intern(ship)?|architect|tester|qa\b|sqa|devops|analyst|scientist|specialist|consultant|administrator|lead|manager|trainee|associate|executive)\b/i
const NOT_A_TITLE = /\b(we are|we're|our team|join us|apply now|send your|click|learn more|read more|cookie|privacy|copyright|©|subscribe|newsletter|testimonial|blog|services?)\b/i
const NO_OPENINGS = /\b(no (current |open )?(openings|vacanc(y|ies)|positions|jobs)|not hiring|currently (no|not)|check back later)\b/i

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim()

function titleCandidates(html: string, pageUrl: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = []
  const push = (raw: string, href?: string) => {
    const title = textOf(raw)
    if (title.length < 4 || title.length > 80 || !ROLE_NOUN.test(title) || NOT_A_TITLE.test(title)) return
    let url = pageUrl
    if (href) {
      try {
        url = new URL(href, pageUrl).href
      } catch {}
    }
    if (!out.some((o) => o.title.toLowerCase() === title.toLowerCase())) out.push({ title, url })
  }
  for (const m of Array.from(html.matchAll(LINK_RE))) push(m[2], m[1])
  for (const m of Array.from(html.matchAll(/<(h[1-5]|li|strong|b|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi))) push(m[2])
  return out
}

function relevance(title: string, words: string[]): number {
  const t = title.toLowerCase()
  return words.reduce((score, w) => (w && t.includes(w) ? score + 1 : score), 0)
}

/**
 * Look for a careers/jobs page on the company's website and an open job on it.
 * Returns null when there is no careers page or no listed opening.
 */
export async function findOpenJob(website: string, siteDomain: string, user: CurrentUser): Promise<JobPost | null> {
  const home = await fetchHtml(website)
  if (!home) return null

  const pages: string[] = []
  for (const m of Array.from(home.html.matchAll(LINK_RE))) {
    if (!CAREERS_LINK.test(m[1]) && !CAREERS_LINK.test(textOf(m[2]))) continue
    try {
      const url = new URL(m[1], home.url)
      const d = domainOf(url.href)
      if (d && sameSite(d, siteDomain) && !pages.includes(url.href) && url.href !== home.url) pages.push(url.href)
    } catch {}
  }
  for (const path of ['/careers', '/jobs']) {
    const url = new URL(path, home.url).href
    if (!pages.includes(url)) pages.push(url)
  }

  const words = [...parseJsonList(user.skills), ...parseJsonList(user.preferredRoles), ...parseJsonList(user.jobKeywords)]
    .map((w) => String(w).toLowerCase().trim())
    .filter((w) => w.length >= 2)

  for (const page of pages.slice(0, 3)) {
    const res = await fetchHtml(page)
    if (!res) continue
    const pageText = htmlToText(res.html)
    const jobs = titleCandidates(res.html, res.url)
    if (!jobs.length || (NO_OPENINGS.test(pageText) && jobs.length < 2)) continue

    const job = [...jobs].sort((a, b) => relevance(b.title, words) - relevance(a.title, words))[0]
    // Apply email: on the job's own page first, then on the careers page. Only careers/HR-style
    // or mailto addresses on the company's own site count; a generic contact address does not.
    const candidates = []
    if (job.url !== res.url && domainOf(job.url) && sameSite(domainOf(job.url)!, siteDomain)) {
      const jobPage = await fetchHtml(job.url)
      if (jobPage) candidates.push(...emailsIn(jobPage.html, jobPage.url))
    }
    candidates.push(...emailsIn(res.html, res.url))
    const applyEmail = candidates.filter((c) => acceptable(c, siteDomain) && rank(c) <= 3).sort((a, b) => rank(a) - rank(b))[0]?.email ?? null
    // No apply email (a form, an applicant-tracking link, or nothing): the caller saves it as "Apply manually".
    return { title: job.title, url: job.url, applyEmail }
  }
  return null
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export class AutoStop extends Error {}

const sleepUntilMessage = (_at: Date) => 'Waiting 2–5 minutes between emails (safety gap).'

async function nextCompany(userId: string) {
  // Companies Auto Apply has not handled yet, and whose draft the user is not editing by hand.
  return prisma.outreachCompany.findFirst({
    where: {
      userId,
      status: { in: ['pending', 'no_email'] },
      AND: [
        { OR: [{ autoCheckedAt: { isSet: false } }, { autoCheckedAt: null }] },
        { OR: [{ draftedAt: { isSet: false } }, { draftedAt: null }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })
}

async function log(userId: string, c: Pick<OutreachCompany, 'id' | 'name' | 'website'>, data: { type: LogType; status: LogStatus; email?: string | null; jobTitle?: string | null; jobUrl?: string | null; error?: string | null }) {
  return prisma.autoOutreachLog.create({
    data: { userId, companyId: c.id, company: c.name, website: c.website, email: data.email ?? null, jobTitle: data.jobTitle ?? null, jobUrl: data.jobUrl ?? null, type: data.type, status: data.status, error: data.error ?? null },
  })
}

const markChecked = (id: string, data: Record<string, unknown> = {}) => prisma.outreachCompany.update({ where: { id }, data: { autoCheckedAt: new Date(), ...data } })

async function emailedBefore(userId: string, email: string, companyId: string) {
  const [previous, logged] = await Promise.all([
    alreadyEmailed(userId, email, companyId),
    prisma.autoOutreachLog.findFirst({ where: { userId, email, status: { in: ['sent', 'pending'] } }, select: { createdAt: true } }),
  ])
  return previous ?? logged?.createdAt ?? null
}

/**
 * Handle one company. Returns true when an email was sent (or a send was attempted, which also
 * starts the 2-5 minute gap), false when it only recorded something or skipped the company.
 */
async function processCompany(user: CurrentUser, company: OutreachCompany, resume: { fileName: string; data: Uint8Array | Buffer }): Promise<boolean> {
  const job = await findOpenJob(company.website, company.domain, user).catch(() => null)

  if (job && !job.applyEmail) {
    await log(user.id, company, { type: 'apply_manually', status: 'pending', jobTitle: job.title, jobUrl: job.url, error: 'Apply on the company website (forms are not filled automatically).' })
    await markChecked(company.id)
    return false
  }

  const to = (job?.applyEmail || company.email || '').trim().toLowerCase()
  if (!to) {
    await markChecked(company.id)
    return false
  }
  const previous = await emailedBefore(user.id, to, company.id)
  if (previous) {
    await markChecked(company.id)
    return false
  }

  const type: LogType = job ? 'job_applied' : 'email'
  // Re-check the switch right before doing anything visible.
  const state = await prisma.autoOutreachState.findUnique({ where: { userId: user.id }, select: { enabled: true } })
  if (!state?.enabled) throw new AutoStop('Auto Apply is off.')

  const row = await log(user.id, company, { type, status: 'pending', email: to, jobTitle: job?.title, jobUrl: job?.url })
  // Claim the company so the manual outreach page cannot send it at the same time.
  const claimed = await prisma.outreachCompany.updateMany({ where: { id: company.id, status: { in: ['pending', 'no_email'] } }, data: { status: 'sending', autoCheckedAt: new Date(), error: null } })
  if (claimed.count === 0) {
    await prisma.autoOutreachLog.delete({ where: { id: row.id } })
    return false
  }

  let subject = ''
  let body = ''
  try {
    const draft = await draftEmail(user, company, job ? { title: job.title, url: job.url } : null)
    subject = draft.subject
    body = draft.body
    const result = await sendApplicationEmail(
      user.id,
      { to, subject, bodyPlain: body, attachment: { fileName: resume.fileName, contentType: 'application/pdf', data: Buffer.from(resume.data) } },
      user.name,
      user.email
    )
    const now = new Date()
    await prisma.outreachCompany.update({
      where: { id: company.id },
      data: { status: 'sent', email: to, subject, body, draftedAt: now, sentAt: now, gmailMessageId: result.messageId, error: null },
    })
    await prisma.autoOutreachLog.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now, gmailMessageId: result.messageId, error: null } })
    await prisma.sentEmail
      .create({
        data: {
          userId: user.id,
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          to,
          subject,
          body,
          company: company.name,
          jobTitle: job?.title ?? null,
          fromEmail: result.from,
          website: company.website,
          source: 'auto_apply',
          emailKind: job ? 'application' : 'inquiry',
          cvFileName: resume.fileName,
          portfolioUrl: user.portfolioUrl,
        },
      })
      .catch((err) => console.error('[auto-apply] email was sent but saving SentEmail failed:', err))
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sending failed.'
    const fatal = error instanceof OutreachKeyError || error instanceof GmailNotConnectedError || error instanceof GmailApiDisabledError || error instanceof GmailScopeError
    if (fatal) {
      // Nothing was sent and nothing else can be: put the company back for later and stop the loop.
      await prisma.outreachCompany.update({ where: { id: company.id }, data: { status: company.status, autoCheckedAt: null, error: message } })
      await prisma.autoOutreachLog.delete({ where: { id: row.id } })
      throw new AutoStop(message)
    }
    await prisma.outreachCompany.update({ where: { id: company.id }, data: { status: 'failed', error: message, ...(subject ? { subject, body } : {}) } })
    await prisma.autoOutreachLog.update({ where: { id: row.id }, data: { status: 'failed', error: message } })
    // A failed AI draft sent nothing: no gap needed. A failed Gmail send may have reached Gmail: keep the gap.
    return !!subject
  }
}

/** One step of the Auto Apply loop. Safe to call often: it only acts when something is due. */
export async function runTick(user: CurrentUser) {
  const now = new Date()
  // Take the per-user lock (atomic) — a second tab or a slow previous tick makes this a no-op.
  await getState(user.id)
  const locked = await prisma.autoOutreachState.updateMany({
    where: { userId: user.id, enabled: true, OR: [{ lockedUntil: { isSet: false } }, { lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS), lastTickAt: now },
  })
  if (locked.count === 0) {
    await prisma.autoOutreachState.updateMany({ where: { userId: user.id, enabled: true }, data: { lastTickAt: now } })
    return getStatus(user)
  }

  const setMessage = (message: string, extra: Record<string, unknown> = {}) =>
    prisma.autoOutreachState.update({ where: { userId: user.id }, data: { message, ...extra } })
  const stop = (message: string) => setMessage(message, { enabled: false })

  try {
    const state = await getState(user.id)
    if (state.nextSendAt && state.nextSendAt > now) {
      await setMessage(sleepUntilMessage(state.nextSendAt))
      return await getStatus(user)
    }
    if ((await sentToday(user.id)) >= AUTO_DAILY_LIMIT) {
      await setMessage(`Daily limit reached (${AUTO_DAILY_LIMIT} emails in 24 hours). Auto Apply continues when the count drops.`)
      return await getStatus(user)
    }
    const missing = await missingRequirement(user)
    if (missing) {
      await stop(`Stopped: ${missing}`)
      return await getStatus(user)
    }
    const resume = (await getPdfResume(user.id))!
    const city = cityOf(user)!

    const started = Date.now()
    let queryIndex = state.queryIndex
    let searches = 0
    while (Date.now() - started < TICK_BUDGET_MS) {
      let company = await nextCompany(user.id)
      if (!company) {
        if (searches >= 1 || queryIndex >= SEARCH_PHRASES.length) {
          await setMessage(
            queryIndex >= SEARCH_PHRASES.length
              ? `No new software houses left to contact in ${city}. Add another city under Preferences to continue.`
              : `Searching for more software houses in ${city}…`,
            { queryIndex }
          )
          break
        }
        const phrase = SEARCH_PHRASES[queryIndex]
        await setMessage(`Searching Google Places for "${phrase}" in ${city}…`)
        const found = await discoverCompanies(user.id, city, phrase, 5)
        searches++
        // Move on to the next phrase once a search brings nothing new.
        if (found.added === 0) queryIndex++
        await prisma.autoOutreachState.update({ where: { userId: user.id }, data: { queryIndex } })
        company = await nextCompany(user.id)
        if (!company) continue
      }

      await setMessage(`Checking ${company.name} (${company.domain})…`)
      const attemptedSend = await processCompany(user, company, resume)
      if (attemptedSend) {
        const next = new Date(Date.now() + randomGap())
        await setMessage(sleepUntilMessage(next), { nextSendAt: next })
        break
      }
    }
    return await getStatus(user)
  } catch (error) {
    if (error instanceof OutreachKeyError || error instanceof AutoStop) {
      await stop(error instanceof AutoStop && error.message === 'Auto Apply is off.' ? 'Auto Apply is off.' : `Stopped: ${error.message}`)
    } else {
      console.error('[auto-apply] tick error:', error)
      await setMessage(`Error: ${error instanceof Error ? error.message : 'unknown error'}. Retrying on the next round.`)
    }
    return await getStatus(user)
  } finally {
    await prisma.autoOutreachState.update({ where: { userId: user.id }, data: { lockedUntil: null } }).catch(() => {})
  }
}
