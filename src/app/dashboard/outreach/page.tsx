'use client'
import '@/lib/normalize-env'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

interface Company {
  id: string
  name: string
  website: string
  city: string | null
  email: string | null
  emailSource: string | null
  status: string
  subject: string | null
  body: string | null
  sentAt: string | null
  error: string | null
}

interface OutreachData {
  companies: Company[]
  sentLast24h: number
  dailyLimit: number
  resume: { fileName: string } | null
  githubUrl: string | null
  portfolioUrl: string | null
  gmailConnected: boolean
  placesConfigured: boolean
  aiConfigured: boolean
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-900',
  approved: 'bg-blue-100 text-blue-900',
  sending: 'bg-blue-100 text-blue-900',
  sent: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  no_email: 'bg-gray-100 text-gray-700',
  skipped: 'bg-gray-100 text-gray-700',
}

const TABS = [
  { key: 'review', label: 'To review', match: (s: string) => s === 'pending' },
  { key: 'approved', label: 'Approved', match: (s: string) => s === 'approved' || s === 'sending' },
  { key: 'sent', label: 'Sent', match: (s: string) => s === 'sent' },
  { key: 'other', label: 'No email / failed / skipped', match: (s: string) => ['no_email', 'failed', 'skipped'].includes(s) },
]

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export default function OutreachPage() {
  const [data, setData] = useState<OutreachData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [city, setCity] = useState('')
  const [query, setQuery] = useState('software house')
  const [github, setGithub] = useState('')
  const [tab, setTab] = useState('review')

  const load = useCallback(async () => {
    try {
      const d: OutreachData = await api('/api/outreach')
      setData(d)
      setGithub((g) => g || d.githubUrl || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      const message = await fn()
      if (message) setNotice(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(null)
      load()
    }
  }

  const discover = () =>
    run('discover', async () => {
      const r = await api('/api/outreach/discover', { method: 'POST', body: JSON.stringify({ city, query }) })
      return `Google listed ${r.listed} places. Added ${r.added} new companies: ${r.withEmail} with a public email, ${r.withoutEmail} without.`
    })

  const draftAll = () =>
    run('draft', async () => {
      let total = 0
      const failures: string[] = []
      for (let round = 0; round < 10; round++) {
        const r = await api('/api/outreach/draft', { method: 'POST', body: '{}' })
        total += r.drafted
        failures.push(...r.errors.map((e: { name: string; error: string }) => `${e.name}: ${e.error}`))
        if (!r.remaining || r.drafted === 0) break
      }
      return `Wrote ${total} draft${total === 1 ? '' : 's'}.${failures.length ? ` Failed: ${failures.join('; ')}` : ''}`
    })

  const sendApproved = () =>
    run('send', async () => {
      const res = await fetch('/api/outreach/send', { method: 'POST' })
      const r = await res.json().catch(() => ({}))
      if (!r.ok) throw new Error(r.error || 'Sending failed')
      return `Sent ${r.sent}, failed ${r.failed}.${r.stoppedBy === 'daily_limit' ? ` Daily limit of ${r.limit} reached; the rest stay approved for later.` : ''}`
    })

  const saveGithub = () =>
    run('github', async () => {
      await api('/api/outreach', { method: 'PUT', body: JSON.stringify({ githubUrl: github }) })
      return 'GitHub link saved.'
    })

  const companies = data?.companies || []
  const activeTab = TABS.find((t) => t.key === tab) || TABS[0]
  const visible = companies.filter((c) => activeTab.match(c.status))
  const approvedCount = companies.filter((c) => c.status === 'approved').length
  const undrafted = companies.filter((c) => c.status === 'pending' && !c.body).length
  const remainingToday = data ? Math.max(0, data.dailyLimit - data.sentLast24h) : 0

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-8 py-6">
        <h1 className="text-3xl font-bold text-gray-900">Outreach</h1>
        <p className="text-gray-600 mt-1">Find software houses, review AI-written emails, and send the ones you approve from your Gmail.</p>
      </div>

      <div className="flex-1 overflow-auto p-8 space-y-6">
        {error && <div className="bg-red-50 border border-red-200 p-4 rounded-lg text-red-800">{error}</div>}
        {notice && <div className="bg-green-50 border border-green-200 p-4 rounded-lg text-green-800">{notice}</div>}

        {data && (
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-3">
            <h2 className="font-semibold text-gray-900">Setup</h2>
            <ul className="text-sm space-y-1">
              <Check ok={data.placesConfigured} text="Google Places API key (GOOGLE_PLACES_API_KEY)" />
              <Check ok={data.aiConfigured} text="AI key for drafts (ANTHROPIC_API_KEY)" />
              <Check ok={data.gmailConnected} text="Gmail connected (sign in with Google)" />
              <Check
                ok={!!data.resume}
                text={data.resume ? `Resume PDF: ${data.resume.fileName}` : 'Resume PDF uploaded'}
                link={data.resume ? undefined : { href: '/dashboard/profile', label: 'Upload' }}
              />
              <Check
                ok={!!data.portfolioUrl}
                text={data.portfolioUrl ? `Portfolio: ${data.portfolioUrl}` : 'Portfolio link (optional)'}
                link={data.portfolioUrl ? undefined : { href: '/dashboard/profile', label: 'Add' }}
              />
            </ul>
            <div className="flex gap-2 items-center pt-2">
              <input
                value={github}
                onChange={(e) => setGithub(e.target.value)}
                placeholder="https://github.com/your-username"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <button onClick={saveGithub} disabled={!!busy} className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
                Save GitHub link
              </button>
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">1. Find software houses</h2>
          <div className="flex flex-wrap gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48" />
            <span className="self-center text-sm text-gray-500">in</span>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City, e.g. Lahore" className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-56" />
            <button onClick={discover} disabled={!!busy || !city.trim()} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {busy === 'discover' ? 'Searching websites…' : 'Find companies'}
            </button>
          </div>
          <p className="text-xs text-gray-500">Emails are read only from each company&apos;s own website (contact, careers and about pages). This can take a minute or two.</p>

          <h2 className="font-semibold text-gray-900 pt-2">2. Write drafts</h2>
          <button onClick={draftAll} disabled={!!busy || undrafted === 0} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {busy === 'draft' ? 'Writing…' : `Write AI drafts (${undrafted} waiting)`}
          </button>

          <h2 className="font-semibold text-gray-900 pt-2">3. Review below, approve, then send</h2>
          <div className="flex items-center gap-4">
            <button onClick={sendApproved} disabled={!!busy || approvedCount === 0 || remainingToday === 0} className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {busy === 'send' ? 'Sending…' : `Send approved (${Math.min(approvedCount, remainingToday)})`}
            </button>
            {data && (
              <span className="text-sm text-gray-600">
                {data.sentLast24h} of {data.dailyLimit} sent in the last 24 hours. An address is never emailed twice.
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="flex gap-2 border-b border-gray-200 mb-4">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === t.key ? 'border-blue-600 text-blue-600 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900'}`}
              >
                {t.label} ({companies.filter((c) => t.match(c.status)).length})
              </button>
            ))}
          </div>
          {!data && !error && <p className="text-gray-500">Loading…</p>}
          {data && visible.length === 0 && <p className="text-gray-500">Nothing here yet.</p>}
          <div className="space-y-4">
            {visible.map((c) => (
              <CompanyCard key={`${c.id}:${c.status}:${c.subject ?? ''}`} company={c} disabled={!!busy} onChanged={load} onError={setError} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Check({ ok, text, link }: { ok: boolean; text: string; link?: { href: string; label: string } }) {
  return (
    <li className={ok ? 'text-gray-700' : 'text-red-700'}>
      {ok ? '✅' : '⚠️'} {text}
      {link && (
        <Link href={link.href} className="ml-2 text-blue-600 hover:underline">
          {link.label}
        </Link>
      )}
    </li>
  )
}

function CompanyCard({ company, disabled, onChanged, onError }: { company: Company; disabled: boolean; onChanged: () => void; onError: (e: string | null) => void }) {
  const [email, setEmail] = useState(company.email || '')
  const [subject, setSubject] = useState(company.subject || '')
  const [body, setBody] = useState(company.body || '')
  const [saving, setSaving] = useState(false)
  const locked = company.status === 'sent' || company.status === 'sending'

  const act = async (action: string) => {
    setSaving(true)
    onError(null)
    try {
      await api(`/api/outreach/companies/${company.id}`, { method: 'PATCH', body: JSON.stringify({ action, email, subject, body }) })
      onChanged()
    } catch (e) {
      onError(`${company.name}: ${e instanceof Error ? e.message : 'failed'}`)
    } finally {
      setSaving(false)
    }
  }

  const rewrite = async () => {
    setSaving(true)
    onError(null)
    try {
      // Keep any address the user typed before asking for a new draft.
      if (email !== (company.email || '')) await api(`/api/outreach/companies/${company.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'save', email }) })
      const r = await api('/api/outreach/draft', { method: 'POST', body: JSON.stringify({ ids: [company.id] }) })
      if (r.errors?.length) throw new Error(r.errors[0].error)
      onChanged()
    } catch (e) {
      onError(`${company.name}: ${e instanceof Error ? e.message : 'failed'}`)
    } finally {
      setSaving(false)
    }
  }

  const off = disabled || saving || locked

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-gray-900">{company.name}</h3>
          <a href={company.website} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline break-all">
            {company.website}
          </a>
          {company.city && <span className="text-sm text-gray-500"> · {company.city}</span>}
        </div>
        <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${STATUS_STYLE[company.status] || 'bg-gray-100'}`}>
          {company.status.replace('_', ' ')}
          {company.sentAt ? ` · ${new Date(company.sentAt).toLocaleDateString()}` : ''}
        </span>
      </div>

      {company.error && <p className="text-sm text-red-700">{company.error}</p>}

      <div className="grid gap-2">
        <label className="text-xs text-gray-500">
          To
          {company.emailSource && (
            <a href={company.emailSource} target="_blank" rel="noreferrer" className="ml-2 text-blue-600 hover:underline">
              (found here)
            </a>
          )}
        </label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} disabled={off} placeholder="contact@company.com" className="border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50" />
        <label className="text-xs text-gray-500">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={off} className="border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50" />
        <label className="text-xs text-gray-500">Body (your resume PDF is attached automatically)</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={off} rows={10} className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50" />
      </div>

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {company.status === 'approved' ? (
            <button onClick={() => act('unapprove')} disabled={off} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
              Unapprove
            </button>
          ) : (
            <button onClick={() => act('approve')} disabled={off || !email || !subject || !body} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
              Save & approve
            </button>
          )}
          <button onClick={() => act('save')} disabled={off} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
            Save
          </button>
          {company.status !== 'approved' && (
            <button onClick={rewrite} disabled={off || !email} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
              {saving ? 'Working…' : company.body ? 'Rewrite with AI' : 'Write with AI'}
            </button>
          )}
          {company.status !== 'skipped' && (
            <button onClick={() => act('skip')} disabled={off} className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
              Skip
            </button>
          )}
        </div>
      )}
    </div>
  )
}
