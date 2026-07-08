import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/useAuth'
import type { ApprovalStepWithDocument } from '../types/documents'

export function MyApprovals() {
  const { session } = useAuth()
  const [steps, setSteps] = useState<ApprovalStepWithDocument[]>([])
  const [comments, setComments] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewedSteps, setViewedSteps] = useState<Set<string>>(new Set())

  const loadSteps = useCallback(async () => {
    if (!session) return
    try {
      const { data: stepsData, error: stepsError } = await supabase
        .from('approval_steps')
        .select('*')
        .eq('approver_id', session.user.id)
        .order('acted_at', { ascending: false, nullsFirst: true })

      if (stepsError) throw stepsError

      if (!stepsData || stepsData.length === 0) {
        setSteps([])
        setLoading(false)
        return
      }

      const docIds = stepsData.map((s) => s.document_id)
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('*')
        .in('id', docIds)

      if (docsError) throw docsError

      const { data: signatures, error: sigsError } = await supabase
        .from('signatures')
        .select('*')
        .in('approval_step_id', stepsData.map((s) => s.id))

      if (sigsError) throw sigsError

      const docMap = new Map(documents?.map((d) => [d.id, d]) ?? [])
      const sigMap = new Map(signatures?.map((s) => [s.approval_step_id, s]) ?? [])

      const enrichedSteps = stepsData.map((step) => ({
        ...step,
        document: docMap.get(step.document_id),
        signatures: sigMap.has(step.id) ? [sigMap.get(step.id)] : [],
      }))

      setSteps((enrichedSteps as ApprovalStepWithDocument[]) ?? [])
    } catch (error) {
      console.error('Load steps error:', error)
      setSteps([])
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    loadSteps()
    const channel = supabase
      .channel('my-approvals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approval_steps' }, loadSteps)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadSteps])

  async function handleViewFile(documentId: string, filePath: string, stepId?: string) {
    const { data } = await supabase.storage.from('documents').createSignedUrl(filePath, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
    supabase.rpc('log_audit_event', { p_event_type: 'document_viewed', p_document_id: documentId })
    if (stepId) setViewedSteps((prev) => new Set(prev).add(stepId))
  }

  async function handleApprove(stepId: string) {
    setActingOn(stepId)
    setError(null)
    const { error } = await supabase.functions.invoke('sign-approval-step', {
      body: { p_step_id: stepId, p_comment: comments[stepId] || null },
    })
    setActingOn(null)
    if (error) {
      // The generic FunctionsHttpError message ("non-2xx status code") hides
      // the actual reason -- sign-approval-step returns it as JSON in the
      // response body, so surface that instead when it's available.
      let message = error.message
      const context = (error as { context?: unknown }).context
      if (context instanceof Response) {
        try {
          const body = await context.clone().json()
          if (body?.error) message = body.error
        } catch {
          // response wasn't JSON; fall back to the generic message above
        }
      }
      setError(message)
      return
    }
    loadSteps()
  }

  async function handleReject(stepId: string) {
    setActingOn(stepId)
    setError(null)
    const { error } = await supabase.rpc('act_on_approval_step', {
      p_step_id: stepId,
      p_decision: 'rejected',
      p_comment: comments[stepId] || null,
    })
    setActingOn(null)
    if (error) {
      setError(error.message)
      return
    }
    loadSteps()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600"></div>
          <p className="mt-2 text-gray-600">Loading approvals...</p>
        </div>
      </div>
    )
  }

  const pending = steps.filter((s) => s.status === 'pending')
  const upcoming = steps.filter((s) => s.status === 'waiting')
  const decided = steps.filter((s) => s.status !== 'pending' && s.status !== 'waiting')

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">My Approvals</h1>
        <p className="mt-2 text-gray-600">Review and sign pending documents</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 p-4 text-red-800">
          <p className="font-medium">⚠ {error}</p>
        </div>
      )}

      <div className="space-y-8">
        {/* Pending Approvals Section */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📋</span>
            <h2 className="text-xl font-semibold text-gray-900">Awaiting Your Decision</h2>
            {pending.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
                {pending.length} pending
              </span>
            )}
          </div>

          {pending.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
              <p className="text-gray-600">✓ No pending approvals right now</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pending.map((step) => (
                <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <button
                        type="button"
                        onClick={() =>
                          step.document &&
                          handleViewFile(step.document.id, step.document.certified_file_path ?? step.document.file_path, step.id)
                        }
                        className="text-lg font-semibold text-orange-600 hover:text-orange-700 hover:underline"
                      >
                        📄 {step.document?.title ?? 'Untitled document'}
                      </button>
                      <p className="mt-1 text-sm text-gray-500">
                        Step {step.step_order} of approval chain
                      </p>
                      {!viewedSteps.has(step.id) && (
                        <p className="mt-1 text-xs text-amber-700">
                          ⚠ View the document above before you can approve or reject it
                        </p>
                      )}
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-3 py-1 text-sm font-medium text-yellow-800">
                      Pending
                    </span>
                  </div>

                  <div className="mt-4 space-y-3">
                    <textarea
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                      placeholder="Add your approval comment (optional)"
                      value={comments[step.id] ?? ''}
                      onChange={(e) => setComments({ ...comments, [step.id]: e.target.value })}
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={actingOn === step.id || !viewedSteps.has(step.id)}
                        onClick={() => handleApprove(step.id)}
                        className="flex-1 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
                      >
                        {actingOn === step.id ? '⏳ Signing...' : '✓ Approve & Sign'}
                      </button>
                      <button
                        type="button"
                        disabled={actingOn === step.id || !viewedSteps.has(step.id)}
                        onClick={() => handleReject(step.id)}
                        className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Upcoming Section: assigned but not yet your turn */}
        {upcoming.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-2xl">🔜</span>
              <h2 className="text-xl font-semibold text-gray-900">Upcoming</h2>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-700">
                {upcoming.length} not yet your turn
              </span>
            </div>

            <div className="space-y-2">
              {upcoming.map((step) => (
                <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <button
                        type="button"
                        onClick={() =>
                          step.document &&
                          handleViewFile(step.document.id, step.document.certified_file_path ?? step.document.file_path)
                        }
                        className="font-medium text-orange-600 hover:text-orange-700 hover:underline"
                      >
                        {step.document?.title ?? 'Untitled document'}
                      </button>
                      <p className="mt-1 text-xs text-gray-500">Step {step.step_order} of approval chain</p>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                      ⏸ Waiting
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Past Decisions Section */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">✅</span>
            <h2 className="text-xl font-semibold text-gray-900">Your Past Decisions</h2>
            {decided.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800">
                {decided.length} total
              </span>
            )}
          </div>

          {decided.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
              <p className="text-gray-600">No decisions yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {decided.map((step) => (
                <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <button
                        type="button"
                        onClick={() =>
                          step.document &&
                          handleViewFile(step.document.id, step.document.certified_file_path ?? step.document.file_path)
                        }
                        className="font-medium text-orange-600 hover:text-orange-700 hover:underline"
                      >
                        {step.document?.title ?? 'Untitled document'}
                      </button>
                      {(step.signatures ?? [])[0] && (
                        <p className="mt-1 text-xs text-gray-500">
                          🔐 Digitally signed • hash {(step.signatures ?? [])[0].document_hash.slice(0, 16)}...
                        </p>
                      )}
                      {step.comment && <p className="mt-1 text-sm text-gray-600">"{step.comment}"</p>}
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
                        step.status === 'approved'
                          ? 'bg-green-100 text-green-800'
                          : step.status === 'rejected'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {step.status === 'approved' ? '✓' : '✕'} {step.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
