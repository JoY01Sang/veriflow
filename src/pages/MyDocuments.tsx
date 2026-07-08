import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/useAuth'
import { verifyDocumentSignature } from '../lib/verify'
import { roleDisplayLabel } from '../lib/roleLabels'
import type { DocumentWithSteps } from '../types/documents'

const statusColor: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  waiting: 'bg-orange-100 text-orange-700',
  skipped: 'bg-gray-100 text-gray-800',
}

type VerifyState = 'checking' | 'valid' | 'invalid' | 'error'

export function MyDocuments() {
  const { session } = useAuth()
  const [documents, setDocuments] = useState<DocumentWithSteps[]>([])
  const [loading, setLoading] = useState(true)
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyState>>({})

  const loadDocuments = useCallback(async () => {
    if (!session) return
    try {
      const { data: docs, error: docsError } = await supabase
        .from('documents')
        .select('*')
        .eq('submitter_id', session.user.id)
        .order('created_at', { ascending: false })

      if (docsError) throw docsError

      if (!docs) {
        setDocuments([])
        setLoading(false)
        return
      }

      const docIds = docs.map((d) => d.id)
      if (docIds.length === 0) {
        setDocuments(docs as DocumentWithSteps[])
        setLoading(false)
        return
      }

      const { data: steps, error: stepsError } = await supabase
        .from('approval_steps')
        .select('*, signatures(*)')
        .in('document_id', docIds)
        .order('step_order', { ascending: true })

      if (stepsError) throw stepsError

      const { data: approvers, error: approversError } = await supabase
        .from('profiles')
        .select('id, full_name, role')

      if (approversError) throw approversError

      const approverMap = new Map(approvers?.map((a) => [a.id, a]) ?? [])
      steps?.forEach((step) => {
        step.approver = approverMap.get(step.approver_id)
      })

      const docMap = new Map(docs.map((d) => [d.id, { ...d, approval_steps: [] }]))
      steps?.forEach((step) => {
        const doc = docMap.get(step.document_id)
        if (doc) doc.approval_steps.push(step)
      })

      setDocuments(Array.from(docMap.values()) as DocumentWithSteps[])
    } catch (error) {
      console.error('Load documents error:', error)
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    loadDocuments()
    const channel = supabase
      .channel('my-documents')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, loadDocuments)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approval_steps' }, loadDocuments)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadDocuments])

  async function handleViewFile(documentId: string, filePath: string) {
    const { data } = await supabase.storage.from('documents').createSignedUrl(filePath, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
    supabase.rpc('log_audit_event', { p_event_type: 'document_viewed', p_document_id: documentId })
  }

  async function handleVerify(stepId: string, filePath: string, signature: DocumentWithSteps['approval_steps'][number]['signatures'][number]) {
    setVerifyResults((prev) => ({ ...prev, [stepId]: 'checking' }))
    try {
      const { signatureValid, hashMatches } = await verifyDocumentSignature(filePath, signature)
      setVerifyResults((prev) => ({
        ...prev,
        [stepId]: signatureValid && hashMatches ? 'valid' : 'invalid',
      }))
    } catch {
      setVerifyResults((prev) => ({ ...prev, [stepId]: 'error' }))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600"></div>
          <p className="mt-2 text-gray-600">Loading documents...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">My Documents</h1>
        <p className="mt-2 text-gray-600">Track and monitor your submissions</p>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-12 text-center">
          <p className="text-lg text-gray-600">📄 You haven't submitted any documents yet</p>
          <p className="mt-2 text-sm text-gray-500">Submit your first document to get started</p>
        </div>
      ) : (
        <div className="space-y-4">
          {documents.map((doc) => (
            <div key={doc.id} className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <button
                    type="button"
                    onClick={() => handleViewFile(doc.id, doc.certified_file_path ?? doc.file_path)}
                    className="text-lg font-semibold text-orange-600 hover:text-orange-700 hover:underline"
                  >
                    {doc.title}
                  </button>
                  <p className="mt-1 text-sm text-gray-500">
                    Submitted {new Date(doc.created_at).toLocaleDateString()} • {doc.approval_steps.length} approvers
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium ${statusColor[doc.status]}`}>
                    {doc.status === 'pending' && '⏳'}
                    {doc.status === 'approved' && '✓'}
                    {doc.status === 'rejected' && '✕'}
                    {doc.status}
                  </span>
                  {doc.status === 'rejected' && (
                    <Link
                      to={`/documents/submit?resubmit=${doc.id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-orange-600 px-3 py-1 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
                    >
                      🔁 Resubmit
                    </Link>
                  )}
                </div>
              </div>

              <div className="mt-5">
                {doc.approval_steps.length === 0 ? (
                  <p className="text-sm text-gray-500">No approval steps</p>
                ) : (
                  <div className="flex flex-wrap items-start gap-y-6">
                    {doc.approval_steps.map((step, index) => {
                      const signature = (step.signatures ?? [])[0]
                      const verifyState = verifyResults[step.id]
                      const prevApproved = index === 0 || doc.approval_steps[index - 1].status === 'approved'
                      return (
                        <div key={step.id} className="flex items-center">
                          {index > 0 && (
                            <div className={`mt-8 h-0.5 w-6 sm:w-10 flex-shrink-0 ${prevApproved ? 'bg-green-400' : 'bg-gray-200'}`} />
                          )}
                          <div className="flex w-40 flex-col items-center rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
                            <span className="text-xl">
                              {step.status === 'pending' && '⏳'}
                              {step.status === 'approved' && '✅'}
                              {step.status === 'rejected' && '❌'}
                              {step.status === 'waiting' && '⏸'}
                              {step.status === 'skipped' && '⏭'}
                            </span>
                            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                              {roleDisplayLabel(step.approver?.role)}
                            </p>
                            <p className="text-sm font-medium text-gray-900">{step.approver?.full_name ?? 'Unknown'}</p>
                            <span className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[step.status]}`}>
                              {step.status}
                            </span>
                            {step.comment && <p className="mt-2 text-xs text-gray-600 italic">"{step.comment}"</p>}
                            {signature && (
                              <div className="mt-2 flex flex-col items-center gap-1 text-xs text-gray-600">
                                <span>🔐 Signed</span>
                                <button
                                  type="button"
                                  onClick={() => handleVerify(step.id, doc.file_path, signature)}
                                  className="font-medium text-orange-600 hover:text-orange-700 hover:underline"
                                >
                                  {verifyState === 'checking' && '⏳ Verifying...'}
                                  {!verifyState && 'Verify'}
                                  {verifyState === 'valid' && '✓ Valid'}
                                  {verifyState === 'invalid' && '✗ Invalid'}
                                  {verifyState === 'error' && 'Error'}
                                </button>
                                {verifyState === 'valid' && <span className="text-green-700 font-medium">Authentic</span>}
                                {verifyState === 'invalid' && <span className="text-red-700 font-medium">Tampered</span>}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
