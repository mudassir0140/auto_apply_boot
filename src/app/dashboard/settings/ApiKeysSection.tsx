'use client'

import { useEffect, useState } from 'react'

type Provider = 'anthropic' | 'gemini'
interface Masked {
  set: boolean
  last4: string | null
  unreadable?: boolean
}
interface KeysState {
  encryptionConfigured: boolean
  aiProvider: Provider
  places: Masked
  anthropic: Masked
  gemini: Masked
}

const PROVIDERS: Record<Provider, { label: string; field: 'anthropicKey' | 'geminiKey'; help: string; url: string }> = {
  anthropic: { label: 'Anthropic (Claude)', field: 'anthropicKey', help: 'Create a key at console.anthropic.com', url: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini (free tier, gemini-2.5-flash)', field: 'geminiKey', help: 'Create a free key in Google AI Studio', url: 'https://aistudio.google.com/apikey' },
}

function describe(k: Masked) {
  if (!k.set) return 'Not set'
  if (k.unreadable) return 'Saved, but unreadable (server key changed). Save it again.'
  return `Saved: ••••${k.last4}`
}

/** Per-user API keys used by Outreach. Keys are sent once to be encrypted; only the last 4 characters come back. */
export default function ApiKeysSection() {
  const [keys, setKeys] = useState<KeysState | null>(null)
  const [places, setPlaces] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/settings/api-keys', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your API keys.'))))
      .then((d: KeysState) => {
        setKeys(d)
        setProvider(d.aiProvider)
      })
      .catch((e) => setMessage({ ok: false, text: e.message }))
  }, [])

  const save = async (payload: Record<string, string | null>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/settings/api-keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Saving failed.')
      setKeys(d)
      setPlaces('')
      setAiKey('')
      setMessage({ ok: true, text: done })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Saving failed.' })
    } finally {
      setBusy(false)
    }
  }

  const current = PROVIDERS[provider]
  const currentKey = keys?.[provider]

  return (
    <div id="api-keys" className="bg-white p-6 rounded-lg shadow mt-8 scroll-mt-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-2">API Keys (Outreach)</h2>
      <p className="text-gray-600 text-sm mb-4">
        Your own keys, used only for your outreach searches and email drafts. They are stored encrypted; only the last 4 characters are ever shown.
      </p>

      {keys && !keys.encryptionConfigured && (
        <div className="mb-4 bg-yellow-50 border border-yellow-200 p-3 rounded text-sm text-yellow-900">
          Keys cannot be saved yet: the server is missing ENCRYPTION_KEY.
        </div>
      )}
      {message && (
        <div className={`mb-4 p-3 rounded text-sm border ${message.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>{message.text}</div>
      )}

      {!keys ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-900">Google Places API key</label>
            <p className="text-xs text-gray-500 mb-2">
              {describe(keys.places)} · Enable &quot;Places API (New)&quot; in{' '}
              <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noreferrer" className="text-blue-600 underline">Google Cloud</a>
            </p>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" value={places} onChange={(e) => setPlaces(e.target.value)} placeholder={keys.places.set ? 'Enter a new key to replace it' : 'AIza…'} className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => save({ placesKey: places }, 'Google Places key saved.')} disabled={busy || !places.trim()} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Save</button>
              {keys.places.set && (
                <button onClick={() => save({ placesKey: null }, 'Google Places key removed.')} disabled={busy} className="px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">AI provider for email drafts</label>
            <div className="flex flex-wrap gap-4 mb-3">
              {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ai-provider"
                    checked={provider === p}
                    disabled={busy}
                    onChange={() => {
                      setProvider(p)
                      setAiKey('')
                      save({ aiProvider: p }, `Drafts will use ${PROVIDERS[p].label}.`)
                    }}
                  />
                  {PROVIDERS[p].label}
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-500 mb-2">
              {current.label} key: {currentKey ? describe(currentKey) : 'Not set'} ·{' '}
              <a href={current.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">{current.help}</a>
            </p>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder={currentKey?.set ? 'Enter a new key to replace it' : `${current.label} API key`} className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => save({ [current.field]: aiKey, aiProvider: provider }, `${current.label} key saved.`)} disabled={busy || !aiKey.trim()} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Save</button>
              {currentKey?.set && (
                <button onClick={() => save({ [current.field]: null }, `${current.label} key removed.`)} disabled={busy} className="px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
