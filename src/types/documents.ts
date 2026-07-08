import type { UserRole } from './auth'

export type DocumentStatus = 'pending' | 'approved' | 'rejected'
export type ApprovalStepStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped'

export interface DocumentRecord {
  id: string
  title: string
  file_path: string
  submitter_id: string
  status: DocumentStatus
  created_at: string
  resubmitted_from: string | null
  certified_file_path: string | null
}

export interface ApprovalStepRecord {
  id: string
  document_id: string
  step_order: number
  approver_id: string
  status: ApprovalStepStatus
  comment: string | null
  acted_at: string | null
}

export interface SignatureRecord {
  id: string
  approval_step_id: string
  document_id: string
  signer_id: string
  document_hash: string
  signature_b64: string
  algorithm: string
  public_key_jwk: JsonWebKey
  created_at: string
}

export interface ApprovalStepWithApprover extends ApprovalStepRecord {
  approver: { full_name: string; role: UserRole } | null
  signatures: SignatureRecord[]
}

export interface DocumentWithSteps extends DocumentRecord {
  approval_steps: ApprovalStepWithApprover[]
}

export interface ApprovalStepWithDocument extends ApprovalStepRecord {
  document: DocumentRecord | null
  signatures: SignatureRecord[]
}
