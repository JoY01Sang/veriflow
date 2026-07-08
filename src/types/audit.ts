export type AuditEventType =
  | 'user_registered'
  | 'user_login'
  | 'document_submitted'
  | 'document_viewed'
  | 'approval_step_approved'
  | 'approval_step_rejected'
  | 'document_signed'
  | 'document_approved'
  | 'document_rejected'
  | 'user_role_changed'
  | 'signing_key_rotated'
  | 'thesis_committee_assigned'

export interface AuditLogRecord {
  id: string
  seq: number
  event_type: AuditEventType
  actor_id: string | null
  document_id: string | null
  approval_step_id: string | null
  metadata: Record<string, unknown>
  prev_hash: string | null
  entry_hash: string
  created_at: string
}

export interface AuditLogWithRelations extends AuditLogRecord {
  actor: { full_name: string } | null
  document: { title: string } | null
}

export interface ChainBreak {
  broken_seq: number
  reason: string
}
