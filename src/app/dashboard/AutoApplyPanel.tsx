'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface AutoRecord {
  id: string
  company: string
  website: string | null
  email: string | null
  jobTitle: string | null
  jobUrl: string | null
  applyUrl: string | null
  source: string | null
  type: 'email' | 'job_applied' | 'apply_manually'
  status: 'sent' | 'failed' | 'pending'
  error: string | null
  createdAt: string
  sentAt: string | null
}

interface AutoStatus {
  enabled: boolean
  running: boolean
  nextSendAt: string | null
  message: string | null
  sentToday: number
  limit: number
  records: AutoRecord[]
  error?: string
}

const TICK_MS = 20_000

const TYPE_LABEL: Record<AutoRecord['type'], string> = {
  email: 'Email',
  job_applied: 'Job applied',
  apply_manually: 'Apply manually',
}

const TYPE_COLOR: Record<AutoRecord['type'], string> = {
  email: 'bg-blue-100 text-blue-800',
  job_applied: 'bg-purple-100 text-purple-800',
  apply_manually: 'bg-orange-100 text-orange-800',
}

const SOURCE_LABEL: Record<string, string> = { remotive: 'Remotive', remoteok: 'RemoteOK', arbeitnow: 'Arbeitnow' }

const STATUS_COLOR: Record<AutoRecord['status'], string> = {
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  pending: 'bg-yellow-100 text-yellow-800',
}

/**
 * "Auto Apply" switch + records. While ON and this page is open, it asks the server
 * to take the next step every 20 seconds. Leaving the page stops it.
 */
export function AutoApplyPanel() {
  const [status, setStatus] = useState<AutoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const apply = useCallback(async (res: Response) => {
    const data = await res.json().catch(() => ({}))
    if (!mounted.current) return
    if (data && typeof data.enabled === 'boolean') setStatus(data)
    setError(res.ok ? null : data?.error || `Request failed (${res.status})`)
  }, [])

  useEffect(() => {
    mounted.current = true
    fetch('/api/auto-apply', { cache: 'no-store' })
      .then(apply)
      .catch(() => mounted.current && setError('Could not load Auto Apply.'))
    return () => {
      mounted.current = false
    }
  }, [apply])

  const enabled = !!status?.enabled

  // The background loop: only while ON and only while this page is mounted.
  useEffect(() => {
    if (!enabled) return
    const tick = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        await apply(await fetch('/api/auto-apply/tick', { method: 'POST', cache: 'no-store' }))
      } catch {
        if (mounted.current) setError('Lost connection to the server. Retrying…')
      } finally {
        inFlight.current = false
      }
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [enabled, apply])

  const toggle = async () => {
    if (!status) return
    setToggling(true)
    try {
      await apply(await fetch('/api/auto-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !status.enabled }) }))
    } catch {
      setError('Could not change Auto Apply.')
    } finally {
      setToggling(false)
    }
  }

  const limitReached = !!status && status.sentToday >= status.limit
  const nextAt = status?.nextSendAt ? new Date(status.nextSendAt) : null
  const waiting = enabled && nextAt && nextAt.getTime() > Date.now()

  return (
    <div className="mb-8 bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Auto Apply</h2>
          <p className="text-sm text-gray-600 mt-1">
            Finds web / frontend / React / Next.js jobs on Remotive, RemoteOK and Arbeitnow. When a post gives an apply email, it sends your application from your Gmail with your resume attached; otherwise it lists the job for you to apply manually.
            Runs only while this page is open.
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-xs text-gray-600 uppercase tracking-wider font-semibold">Today</p>
            <p className={`text-2xl font-bold ${limitReached ? 'text-red-600' : 'text-gray-900'}`}>
              {status ? `${status.sentToday} / ${status.limit}` : '–'}
            </p>
            <p className="text-xs text-gray-500">emails, last 24 h</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Auto Apply"
            onClick={toggle}
            disabled={!status || toggling}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition disabled:opacity-50 ${enabled ? 'bg-green-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition ${enabled ? 'translate-x-7' : 'translate-x-1'}`} />
          </button>
          <span className={`text-sm font-semibold w-8 ${enabled ? 'text-green-700' : 'text-gray-500'}`}>{enabled ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      <div className="px-6 py-3 border-b border-gray-200 text-sm">
        {error ? (
          <p className="text-red-700">
            {error}{' '}
            {/Profile/.test(error) && <Link href="/dashboard/profile" className="underline">Open Profile</Link>}
          </p>
        ) : (
          <p className={enabled ? 'text-gray-800' : 'text-gray-500'}>
            {enabled && <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2 animate-pulse" />}
            {status?.message || (enabled ? 'Running…' : 'Auto Apply is off.')}
            {waiting && nextAt && <span className="text-gray-500"> Next email at {nextAt.toLocaleTimeString()}.</span>}
          </p>
        )}
        <p className="text-xs text-gray-500 mt-1">Limits: max {status?.limit ?? 20} emails per 24 hours, 2–5 minutes between emails, never the same address twice. Forms are never filled automatically.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Company', 'Job title', 'Email or link', 'Type', 'Status', 'Date'].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {status && status.records.length > 0 ? (
              status.records.map((r) => (
                <tr key={r.id} className="border-b border-gray-200 hover:bg-gray-50 transition">
                  <td className="px-6 py-3 text-sm text-gray-900 font-medium">
                    {r.website ? (
                      <a href={r.website} target="_blank" rel="noopener noreferrer" className="hover:underline">{r.company}</a>
                    ) : (
                      r.company
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-700">
                    {r.jobTitle ? (
                      r.jobUrl ? (
                        <a href={r.jobUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title="Original job post">
                          {r.jobTitle}
                        </a>
                      ) : (
                        r.jobTitle
                      )
                    ) : (
                      '—'
                    )}
                    {r.source && <p className="text-xs text-gray-500 mt-0.5">via {SOURCE_LABEL[r.source] || r.source}</p>}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-700 max-w-xs break-all">
                    {r.email ? (
                      r.email
                    ) : r.applyUrl || r.jobUrl ? (
                      <a href={(r.applyUrl || r.jobUrl)!} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        Apply here ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLOR[r.type] || 'bg-gray-100 text-gray-800'}`}>
                      {TYPE_LABEL[r.type] || r.type}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    <span title={r.error || undefined} className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[r.status] || 'bg-gray-100 text-gray-800'}`}>
                      {r.status}
                    </span>
                    {r.status === 'failed' && r.error && <p className="text-xs text-red-600 mt-1 max-w-xs">{r.error}</p>}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-500 whitespace-nowrap">{new Date(r.sentAt || r.createdAt).toLocaleString()}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  {status ? 'Nothing yet. Turn Auto Apply ON and keep this page open.' : 'Loading…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
