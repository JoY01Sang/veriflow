import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase, supabaseAnonKey, supabaseUrl } from '../lib/supabase'
import { useAuth } from '../auth/useAuth'
import { roleDisplayLabel } from '../lib/roleLabels'
import type { UserRole } from '../types/auth'

interface ChainMember {
  id: string
  full_name: string
  role: UserRole
}

type ChainSlotKey = 'advisor_id' | 'committee_member_1_id' | 'committee_member_2_id' | 'committee_member_3_id' | 'committee_member_4_id' | 'committee_member_5_id' | 'department_chair_id' | 'graduate_school_id'

const CHAIN_SLOTS: { key: ChainSlotKey; label: string }[] = [
  { key: 'advisor_id', label: 'Advisor' },
  { key: 'committee_member_1_id', label: 'Committee Member 1' },
  { key: 'committee_member_2_id', label: 'Committee Member 2' },
  { key: 'committee_member_3_id', label: 'Committee Member 3' },
  { key: 'committee_member_4_id', label: 'Committee Member 4' },
  { key: 'committee_member_5_id', label: 'Committee Member 5' },
  { key: 'department_chair_id', label: 'Department Chair' },
  { key: 'graduate_school_id', label: 'Graduate School' },
]

// supabase-js has no upload progress hook, so the storage REST endpoint is
// called directly via XHR (same request the client itself makes) purely to
// get progress events for the bar below.
function uploadWithProgress(
  filePath: string,
  file: File,
  accessToken: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${supabaseUrl}/storage/v1/object/documents/${filePath}`)
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    xhr.setRequestHeader('apikey', supabaseAnonKey)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', 'false')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        let message = `Upload failed (${xhr.status})`
        try {
          message = JSON.parse(xhr.responseText)?.message ?? message
        } catch {
          // response wasn't JSON; fall back to the generic message above
        }
        reject(new Error(message))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    xhr.send(file)
  })
}

export function SubmitDocument() {
  const { session, profile } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const resubmitFrom = searchParams.get('resubmit')
  const [chain, setChain] = useState<Record<ChainSlotKey, ChainMember | null>>(
    Object.fromEntries(CHAIN_SLOTS.map((slot) => [slot.key, null])) as Record<ChainSlotKey, ChainMember | null>,
  )
  const [chainLoading, setChainLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [phase, setPhase] = useState<'uploading' | 'saving' | null>(null)

  useEffect(() => {
    if (!profile) return

    const ids = CHAIN_SLOTS.map((slot) => profile[slot.key]).filter((id): id is string => !!id)

    if (ids.length === 0) {
      setChainLoading(false)
      return
    }

    supabase
      .from('profiles')
      .select('id, full_name, role')
      .in('id', ids)
      .then(({ data }) => {
        const byId = new Map((data ?? []).map((m) => [m.id, m as ChainMember]))
        const resolved = {} as Record<ChainSlotKey, ChainMember | null>
        for (const slot of CHAIN_SLOTS) {
          const id = profile[slot.key]
          resolved[slot.key] = id ? byId.get(id) ?? null : null
        }
        setChain(resolved)
        setChainLoading(false)
      })
  }, [profile])

  // Prefill the title from the rejected document being resubmitted; the
  // approval chain is always the student's current fixed committee, so
  // there's nothing to prefill there.
  useEffect(() => {
    if (!resubmitFrom) return

    supabase
      .from('documents')
      .select('title')
      .eq('id', resubmitFrom)
      .single()
      .then(({ data }) => {
        if (data?.title) setTitle(data.title)
      })
  }, [resubmitFrom])

  const chainComplete = CHAIN_SLOTS.every((slot) => chain[slot.key])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    if (!file) {
      setError('Please choose a file to upload.')
      return
    }
    if (!chainComplete) {
      setError('Your thesis committee has not been fully assigned yet — contact the registrar.')
      return
    }

    setSubmitting(true)
    setError(null)
    setUploadProgress(0)
    setPhase('uploading')

    const userId = session.user.id
    const filePath = `${userId}/${crypto.randomUUID()}-${file.name}`

    try {
      await uploadWithProgress(filePath, file, session.access_token, setUploadProgress)
    } catch (uploadError) {
      setSubmitting(false)
      setPhase(null)
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.')
      return
    }

    setPhase('saving')

    // Document + approval steps are created together by one RPC (a single
    // DB transaction) so a failure here can't leave behind a document with
    // no steps -- which would otherwise sit there forever with nothing to
    // act on, since no step is ever pending.
    const { error: submitError } = await supabase.rpc('submit_document', {
      p_title: title,
      p_file_path: filePath,
      p_resubmitted_from: resubmitFrom,
    })

    if (submitError) {
      await supabase.storage.from('documents').remove([filePath])
      setSubmitting(false)
      setPhase(null)
      setError(submitError.message)
      return
    }

    setSubmitting(false)
    setPhase(null)
    navigate('/documents')
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">
          {resubmitFrom ? 'Resubmit Thesis' : 'Submit Thesis'}
        </h1>
        <p className="mt-2 text-gray-600">
          {resubmitFrom
            ? 'Title prefilled from the rejected submission — attach a file to resubmit'
            : 'Your thesis will route through your assigned approval chain below'}
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Title Field */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Thesis Title
            </label>
            <input
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 transition-all"
              placeholder="e.g., Machine Learning Approaches to Climate Modeling"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          {/* File Field */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Upload File
            </label>
            <div className="relative">
              <input
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 file:rounded-lg file:border-0 file:bg-orange-600 file:text-white file:font-medium file:px-4 file:py-2 file:mr-4 file:cursor-pointer hover:file:bg-orange-700 transition-colors"
                type="file"
                onChange={handleFileChange}
                required
              />
              {file && <p className="mt-1 text-xs text-gray-600">Selected: {file.name}</p>}
            </div>
          </div>

          {/* Approval Chain (read-only, registrar-assigned) */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-3">Your Approval Chain</label>

            {chainLoading ? (
              <p className="text-sm text-gray-500">Loading your committee...</p>
            ) : (
              <div className="space-y-2 rounded-lg bg-gray-50 p-3">
                {CHAIN_SLOTS.map((slot, index) => {
                  const member = chain[slot.key]
                  return (
                    <div
                      key={slot.key}
                      className="flex items-center justify-between rounded-lg bg-white px-3 py-2 border border-gray-200"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-600 text-xs font-semibold text-white">
                          {index + 1}
                        </span>
                        <div>
                          <p className="font-medium text-gray-900">{member ? member.full_name : 'Not yet assigned'}</p>
                          <p className="text-xs text-gray-500">{member ? roleDisplayLabel(member.role) : slot.label}</p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {!chainLoading && !chainComplete && (
              <div className="mt-3 rounded-lg bg-yellow-50 border border-yellow-200 p-3">
                <p className="text-sm text-yellow-800">
                  ⚠ Your thesis committee hasn't been fully assigned yet. Contact the registrar before submitting.
                </p>
              </div>
            )}
          </div>

          {/* Progress Bar */}
          {phase && (
            <div>
              <div className="flex justify-between text-xs font-medium text-gray-600 mb-1">
                <span>{phase === 'uploading' ? '📤 Uploading file' : '💾 Saving document'}</span>
                {phase === 'uploading' && <span>{uploadProgress ?? 0}%</span>}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-600 transition-all duration-300"
                  style={{ width: `${phase === 'uploading' ? uploadProgress ?? 0 : 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800">
              <p className="text-sm font-medium">⚠ {error}</p>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={submitting || chainLoading || !chainComplete}
            className="w-full rounded-lg bg-orange-600 px-4 py-3 text-white font-semibold hover:bg-orange-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <span className="inline-block animate-spin">⏳</span>
                Submitting...
              </>
            ) : (
              <>
                📤 Submit for Approval
              </>
            )}
          </button>
        </form>
      </div>

      {/* Info Box */}
      <div className="mt-6 rounded-lg bg-blue-50 border border-blue-200 p-4">
        <p className="text-sm text-blue-800">
          <span className="font-semibold">ℹ Pro tip:</span> Your thesis will be digitally signed by each reviewer as they approve. You can verify signatures in the "My Documents" section.
        </p>
      </div>
    </div>
  )
}
