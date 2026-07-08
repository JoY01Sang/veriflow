import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../lib/supabase'
import { profileRoleLabel } from '../lib/roleLabels'

export function Settings() {
  const { profile, refreshProfile } = useAuth()
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [rotateError, setRotateError] = useState<string | null>(null)
  const [rotated, setRotated] = useState(false)

  if (!profile) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-red-800 font-medium">⚠ Profile not found</p>
      </div>
    )
  }

  const roleLabel = profileRoleLabel(profile)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)

    const trimmed = fullName.trim()
    if (!trimmed) {
      setError('Full name is required')
      return
    }

    setSaving(true)
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ full_name: trimmed })
      .eq('id', profile.id)
    setSaving(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    await refreshProfile()
    setSaved(true)
  }

  async function handleRotateKey() {
    if (!window.confirm('Generate a new signing key? Future signatures will use the new key; past signatures stay valid and unaffected.')) {
      return
    }
    setRotateError(null)
    setRotated(false)
    setRotating(true)
    const { error: rotateErr } = await supabase.functions.invoke('rotate-signing-key')
    setRotating(false)
    if (rotateErr) {
      setRotateError(rotateErr.message)
      return
    }
    setRotated(true)
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="mt-2 text-gray-600">Manage your account details</p>
      </div>

      <form onSubmit={handleSave} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
        <div>
          <label htmlFor="fullName" className="block text-sm font-medium text-gray-700 mb-1">
            Full Name
          </label>
          <input
            id="fullName"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            type="text"
            value={profile.email}
            disabled
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Account Type</label>
          <input
            type="text"
            value={roleLabel}
            disabled
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Role changes can only be made by the registrar, to prevent unauthorized privilege escalation.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800 text-sm">⚠ {error}</div>
        )}
        {saved && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-green-800 text-sm">
            ✓ Settings saved
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>

      {profile.role !== 'student' && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">🔑 Signing Key</h2>
          <p className="text-sm text-gray-600 mb-4">
            Your documents are signed with a server-managed key. If you believe it may have been
            compromised, you can generate a new one. Past signatures stay valid and unaffected —
            only future signatures will use the new key.
          </p>

          {rotateError && (
            <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-red-800 text-sm">
              ⚠ {rotateError}
            </div>
          )}
          {rotated && (
            <div className="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-green-800 text-sm">
              ✓ Signing key rotated
            </div>
          )}

          <button
            type="button"
            onClick={handleRotateKey}
            disabled={rotating}
            className="rounded-lg border border-orange-300 px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50 transition-colors"
          >
            {rotating ? 'Rotating...' : 'Rotate Signing Key'}
          </button>
        </div>
      )}
    </div>
  )
}
