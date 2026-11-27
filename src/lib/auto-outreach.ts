import { prisma } from './prisma'
import { parseJsonList, type CurrentUser } from './session'
import { alreadyEmailed, getPdfResume, OUTREACH_DAILY_LIMIT } from './outreach'
import { extractApplyEmail, extractAtsUrl, stripHtml } from './jobs'
import { sendApplicationEmail, GmailApiDisabledError, GmailNotConnectedError, GmailScopeError } from './gmail'

/**
 * Auto Apply: applies to web / frontend / React / Next.js jobs while the user has /dashboard open.
 * Needs no API keys — only the user's Google sign-in (Gmail) and a PDF resume.
 *
 * Jobs come from free public job boards (Remotive, RemoteOK, Arbeitnow). The dashboard calls
 * runTick() every ~20 seconds while the switch is ON. Each tick:
 *  - does nothing if the switch is OFF, another tick is running, the daily limit is reached,
 *    or the 2-5 minute gap since the last email has not passed yet;
 *  - otherwise goes through new matching job posts (newest first):
 *      post names an apply email -> template application email from the user's Gmail with the
 *                                   resume attached ("Job applied"); at most ONE per tick
 *      post has only an apply link -> saved as "Apply manually" (forms are never filled)
 *  - never handles the same post twice and never emails an address that was emailed before
 *    (by Auto Apply, outreach or a job application).
 * Closing the dashboard stops the ticks, so nothing runs while the user is away.
 */

export const AUTO_DAILY_LIMIT = OUTREACH_DAILY_LIMIT // 20
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_GAP_MS = 2 * 60 * 1000
const MAX_GAP_MS = 5 * 60 * 1000
const LOCK_MS = 4 * 60 * 1000
const ACTIVE_MS = 90 * 1000 // a tick within this window = the dashboard is open and running
const MANUAL_PER_TICK = 5 // "Apply manually" rows saved per tick, so the table fills gradually
const FEED_TTL_MS = 60 * 60 * 1000 // job boards ask clients not to poll often

export type LogType = 'email' | 'job_applied' | 'apply_manually'
export type LogStatus = 'sent' | 'failed' | 'pending'
export type JobSource = 'remotive' | 'remoteok' | 'arbeitnow'

const randomGap = () => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1))

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
      select: {
        id: true, company: true, website: true, email: true, jobTitle: true, jobUrl: true, applyUrl: true, source: true,
        type: true, status: true, error: true, createdAt: true, sentAt: true,
      },
    }),
  ])
  return {
    enabled: state.enabled,
    running: state.enabled && !!state.lastTickAt && Date.now() - state.lastTickAt.getTime() < ACTIVE_MS,
    nextSendAt: state.nextSendAt,
    // The previous (API-key based) version could leave this message saved; it no longer applies.
    message: state.message && /not available right now/i.test(state.message) ? (state.enabled ? 'Starting…' : 'Auto Apply is off.') : state.message,
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
  const message = enabled ? 'Starting…' : 'Auto Apply is off.'
  await prisma.autoOutreachState.upsert({ where: { userId: user.id }, update: { enabled, message }, create: { userId: user.id, enabled, message } })
  return { ok: true as const }
}

// ---------------------------------------------------------------------------
// Job boards (free, no API key)
// ---------------------------------------------------------------------------

export interface BoardJob {
  title: string
  company: string
  url: string // original post
  applyEmail: string | null
  applyUrl: string // where a human applies
  source: JobSource
}

// Web / frontend / React / Next.js roles, judged by the TITLE (tags are too broad).
// Full-stack counts only when React / Next.js / JavaScript / TypeScript is named. React Native is mobile.
const WEB_TITLE = /\b(front[- ]?end|frontend|react(\.?js)?|next\.?js|web (developer|engineer|dev)|javascript|typescript)\b/i
const FULL_STACK = /\b(full[- ]?stack|fullstack)\b/i
const JS_STACK = /\b(react(\.?js)?|next\.?js|javascript|typescript)\b/i
const NOT_WEB = /\b(react native|android|ios|flutter|java|\.net|c#|golang|rust|ruby|rails|php|data (scientist|engineer)|devops|back[- ]?end|backend)\b/i

export const isWebJob = (title: string, tags: string[] = []) => {
  if (NOT_WEB.test(title)) return false
  if (WEB_TITLE.test(title)) return true
  return FULL_STACK.test(title) && JS_STACK.test(`${title} ${tags.join(' ')}`)
}

const oneLine = (s: unknown, max = 120) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; BootAutoApply/1.0)', Accept: 'application/json' }

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000), cache: 'no-store' })
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`)
  return res.json()
}

function toJob(source: JobSource, raw: { title: unknown; company: unknown; url: unknown; html: unknown; applyUrl?: unknown; tags?: unknown }): BoardJob | null {
  const title = oneLine(raw.title)
  const company = oneLine(raw.company, 80)
  const url = typeof raw.url === 'string' ? raw.url : ''
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  if (!title || !company || !/^https?:\/\//i.test(url) || !isWebJob(title, tags)) return null
  const html = String(raw.html || '')
  const applyEmail = extractApplyEmail(stripHtml(html), company) || null
  const direct = typeof raw.applyUrl === 'string' && /^https?:\/\//i.test(raw.applyUrl) ? raw.applyUrl : null
  return { title, company, url, applyEmail, applyUrl: direct || extractAtsUrl(html) || url, source }
}

async function fromRemotive(): Promise<BoardJob[]> {
  const data = (await getJson('https://remotive.com/api/remote-jobs?category=software-dev')) as { jobs?: Record<string, unknown>[] }
  return (data.jobs || []).map((j) => toJob('remotive', { title: j.title, company: j.company_name, url: j.url, html: j.description, tags: j.tags })).filter((j): j is BoardJob => !!j)
}

async function fromRemoteOk(): Promise<BoardJob[]> {
  const data = await getJson('https://remoteok.com/api')
  // The first element is RemoteOK's legal notice, not a job.
  return (Array.isArray(data) ? (data as Record<string, unknown>[]) : [])
    .filter((j) => j && j.position)
    .map((j) => toJob('remoteok', { title: j.position, company: j.company, url: j.url, html: j.description, applyUrl: j.apply_url, tags: j.tags }))
    .filter((j): j is BoardJob => !!j)
}

async function fromArbeitnow(): Promise<BoardJob[]> {
  const data = (await getJson('https://www.arbeitnow.com/api/job-board-api')) as { data?: Record<string, unknown>[] }
  return (data.data || []).map((j) => toJob('arbeitnow', { title: j.title, company: j.company_name, url: j.url, html: j.description, tags: j.tags })).filter((j): j is BoardJob => !!j)
}

let feed: { at: number; jobs: BoardJob[]; errors: string[] } | null = null

/** Matching web jobs from all three boards, cached for an hour (per server instance). */
export async function loadBoardJobs(): Promise<{ jobs: BoardJob[]; errors: string[] }> {
  if (feed && Date.now() - feed.at < FEED_TTL_MS && feed.jobs.length) return feed
  const results = await Promise.allSettled([fromRemotive(), fromRemoteOk(), fromArbeitnow()])
  const names = ['Remotive', 'RemoteOK', 'Arbeitnow']
  const jobs: BoardJob[] = []
  const errors: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') jobs.push(...r.value)
    else {
      errors.push(names[i])
      console.error(`[auto-apply] ${names[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason)
    }
  })
  const seen = new Set<string>()
  const unique = jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)))
  feed = { at: Date.now(), jobs: unique, errors }
  return feed
}

// ---------------------------------------------------------------------------
// Fixed email template (no AI)
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<JobSource, string> = { remotive: 'Remotive', remoteok: 'RemoteOK', arbeitnow: 'Arbeitnow' }

function describeProject(item: unknown): string {
  if (typeof item === 'string') return oneLine(item, 160)
  if (!item || typeof item !== 'object') return ''
  const o = item as Record<string, unknown>
  const name = oneLine(o.name ?? o.title, 60)
  const what = oneLine(o.description, 120)
  const tech = Array.isArray(o.technologies) ? o.technologies.map(String).slice(0, 4).join(', ') : ''
  return [name, what].filter(Boolean).join(': ') + (tech ? ` (${tech})` : '')
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildApplicationEmail(user: CurrentUser, job: Pick<BoardJob, 'title' | 'company' | 'source'>) {
  const name = oneLine(user.name, 80) || user.email
  const role = oneLine(parseJsonList(user.preferredRoles)[0], 60) || 'web developer'
  const skills = parseJsonList(user.skills).map((s) => oneLine(s, 40)).filter(Boolean).slice(0, 8)
  const projects = (parseJsonList(user.projects) as unknown[]).map(describeProject).filter(Boolean).slice(0, 3)
  const links: Array<[string, string]> = []
  if (user.portfolioUrl) links.push(['Portfolio', user.portfolioUrl])
  if (user.githubUrl) links.push(['GitHub', user.githubUrl])

  const lines: string[] = [
    `Dear ${job.company} Hiring Team,`,
    '',
    `My name is ${name}, and I am a ${/^an? /i.test(role) ? role.replace(/^an? /i, '') : role}. I would like to apply for the ${job.title} position at ${job.company}, which I found on ${SOURCE_LABEL[job.source]}.`,
  ]
  if (skills.length) lines.push('', `My main skills are ${skills.join(', ')}.`)
  if (projects.length) lines.push('', 'Some of the projects I have built:', ...projects.map((p) => `- ${p}`))
  if (links.length) lines.push('', ...links.map(([label, url]) => `${label}: ${url}`))
  lines.push(
    '',
    `My resume is attached. I would be glad to talk about how I can contribute to ${job.company}.`,
    '',
    'Thank you for your time and consideration.',
    '',
    'Kind regards,',
    name,
    user.email
  )

  const bodyPlain = lines.join('\n')
  const linkify = (line: string) => {
    const hit = links.find(([label]) => line.startsWith(`${label}: `))
    return hit ? `${hit[0]}: <a href="${escapeHtml(hit[1])}">${escapeHtml(hit[1])}</a>` : escapeHtml(line)
  }
  const bodyHtml = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">${lines.map((l) => (l ? linkify(l) : '')).join('<br>')}</div>`
  const subject = oneLine(`Application for ${job.title} – ${name}`, 150)
  return { subject, bodyPlain, bodyHtml }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export class AutoStop extends Error {}

const WAIT_MESSAGE = 'Waiting 2–5 minutes between emails (safety gap).'

async function emailedBefore(userId: string, email: string) {
  const [previous, logged] = await Promise.all([
    alreadyEmailed(userId, email),
    prisma.autoOutreachLog.findFirst({ where: { userId, email, status: { in: ['sent', 'pending'] }, type: { not: 'apply_manually' } }, select: { createdAt: true } }),
  ])
  return previous ?? logged?.createdAt ?? null
}

const logJob = (userId: string, job: BoardJob, data: { type: LogType; status: LogStatus; email?: string | null; error?: string | null }) =>
  prisma.autoOutreachLog.create({
    data: {
      userId,
      company: job.company,
      jobTitle: job.title,
      jobUrl: job.url,
      applyUrl: job.applyUrl,
      source: job.source,
      email: data.email ?? null,
      type: data.type,
      status: data.status,
      error: data.error ?? null,
    },
  })

/** Send one application. Returns true when a send was attempted (starts the 2-5 minute gap). */
async function applyByEmail(user: CurrentUser, job: BoardJob, to: string, resume: { fileName: string; data: Uint8Array | Buffer }): Promise<boolean> {
  // Re-check the switch right before doing anything visible.
  const state = await prisma.autoOutreachState.findUnique({ where: { userId: user.id }, select: { enabled: true } })
  if (!state?.enabled) throw new AutoStop('Auto Apply is off.')

  const row = await logJob(user.id, job, { type: 'job_applied', status: 'pending', email: to })
  const { subject, bodyPlain, bodyHtml } = buildApplicationEmail(user, job)
  try {
    const result = await sendApplicationEmail(
      user.id,
      { to, subject, bodyPlain, bodyHtml, attachment: { fileName: resume.fileName, contentType: 'application/pdf', data: Buffer.from(resume.data) } },
      user.name,
      user.email
    )
    const now = new Date()
    await prisma.autoOutreachLog.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now, gmailMessageId: result.messageId, error: null } })
    await prisma.sentEmail
      .create({
        data: {
          userId: user.id,
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          to,
          subject,
          body: bodyPlain,
          company: job.company,
          jobTitle: job.title,
          fromEmail: result.from,
          website: job.url,
          source: job.source,
          emailKind: 'application',
          cvFileName: resume.fileName,
          portfolioUrl: user.portfolioUrl,
        },
      })
      .catch((err) => console.error('[auto-apply] email was sent but saving SentEmail failed:', err))
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sending failed.'
    if (error instanceof GmailNotConnectedError || error instanceof GmailApiDisabledError || error instanceof GmailScopeError) {
      // Nothing was sent and nothing else can be: forget this attempt (the job is retried later) and stop.
      await prisma.autoOutreachLog.delete({ where: { id: row.id } })
      throw new AutoStop(message)
    }
    await prisma.autoOutreachLog.update({ where: { id: row.id }, data: { status: 'failed', error: message } })
    return true // it may have reached Gmail: keep the gap
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

  try {
    const state = await getState(user.id)
    if (state.nextSendAt && state.nextSendAt > now) {
      await setMessage(WAIT_MESSAGE)
      return await getStatus(user)
    }
    const missing = await missingRequirement(user)
    if (missing) {
      await setMessage(`Stopped: ${missing}`, { enabled: false })
      return await getStatus(user)
    }
    const resume = (await getPdfResume(user.id))!
    const limitReached = (await sentToday(user.id)) >= AUTO_DAILY_LIMIT

    const { jobs, errors } = await loadBoardJobs()
    if (!jobs.length) {
      await setMessage(errors.length ? `Job boards could not be reached (${errors.join(', ')}). Retrying shortly.` : 'No web / React / Next.js jobs on the job boards right now. Checking again later.')
      return await getStatus(user)
    }

    // Posts this user already handled (any outcome) are never processed again.
    const handled = new Set(
      (await prisma.autoOutreachLog.findMany({ where: { userId: user.id, jobUrl: { in: jobs.map((j) => j.url) } }, select: { jobUrl: true } })).map((r) => r.jobUrl)
    )

    let manual = 0
    let skippedDuplicates = 0
    for (const job of jobs) {
      if (handled.has(job.url)) continue
      const to = job.applyEmail?.trim().toLowerCase()
      if (!to) {
        if (manual >= MANUAL_PER_TICK) continue
        await logJob(user.id, job, { type: 'apply_manually', status: 'pending' })
        manual++
        continue
      }
      if (limitReached) continue // email jobs wait until the 24-hour count drops
      if (await emailedBefore(user.id, to)) {
        skippedDuplicates++
        continue
      }
      await setMessage(`Applying to ${job.title} at ${job.company}…`)
      if (await applyByEmail(user, job, to, resume)) {
        await setMessage(WAIT_MESSAGE, { nextSendAt: new Date(Date.now() + randomGap()) })
        return await getStatus(user)
      }
    }

    await setMessage(
      limitReached
        ? `Daily limit reached (${AUTO_DAILY_LIMIT} emails in 24 hours). Jobs that need a manual application are still listed.`
        : `Checked ${jobs.length} matching jobs. No new job with an apply email right now${skippedDuplicates ? ` (${skippedDuplicates} skipped: address already emailed)` : ''}. Checking again shortly.`
    )
    return await getStatus(user)
  } catch (error) {
    if (error instanceof AutoStop) {
      await setMessage(error.message === 'Auto Apply is off.' ? error.message : `Stopped: ${error.message}`, { enabled: false })
    } else {
      console.error('[auto-apply] tick error:', error)
      await setMessage(`Error: ${error instanceof Error ? error.message : 'unknown error'}. Retrying on the next round.`)
    }
    return await getStatus(user)
  } finally {
    await prisma.autoOutreachState.update({ where: { userId: user.id }, data: { lockedUntil: null } }).catch(() => {})
  }
}
