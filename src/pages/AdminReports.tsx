import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/useAuth'
import type { AuditLogWithRelations, ChainBreak } from '../types/audit'
import type { Profile, UserRole } from '../types/auth'
import { roleDisplayLabel } from '../lib/roleLabels'

interface Stats {
  documentsTotal: number
  documentsPending: number
  documentsApproved: number
  documentsRejected: number
  stepsOutstanding: number
  signaturesTotal: number
  usersTotal: number
}

const eventLabel: Record<string, string> = {
  user_registered: 'User registered',
  user_login: 'User logged in',
  document_submitted: 'Document submitted',
  document_viewed: 'Document viewed',
  approval_step_approved: 'Approval step approved',
  approval_step_rejected: 'Approval step rejected',
  document_signed: 'Document signed',
  document_approved: 'Document approved',
  document_rejected: 'Document rejected',
  user_role_changed: 'User role changed',
  signing_key_rotated: 'Signing key rotated',
  thesis_committee_assigned: 'Thesis committee assigned',
}

const committeeSlots: { key: CommitteeSlotKey; label: string; role: UserRole }[] = [
  { key: 'advisor_id', label: 'Advisor', role: 'advisor' },
  { key: 'committee_member_1_id', label: 'Committee Member 1', role: 'committee_member' },
  { key: 'committee_member_2_id', label: 'Committee Member 2', role: 'committee_member' },
  { key: 'committee_member_3_id', label: 'Committee Member 3', role: 'committee_member' },
  { key: 'committee_member_4_id', label: 'Committee Member 4', role: 'committee_member' },
  { key: 'committee_member_5_id', label: 'Committee Member 5', role: 'committee_member' },
  { key: 'department_chair_id', label: 'Dept Chair', role: 'department_chair' },
  { key: 'graduate_school_id', label: 'Grad School', role: 'graduate_school' },
]

type CommitteeSlotKey =
  | 'advisor_id'
  | 'committee_member_1_id'
  | 'committee_member_2_id'
  | 'committee_member_3_id'
  | 'committee_member_4_id'
  | 'committee_member_5_id'
  | 'department_chair_id'
  | 'graduate_school_id'

const roleOptions: UserRole[] = [
  'student',
  'advisor',
  'committee_member',
  'department_chair',
  'graduate_school',
  'registrar',
]

async function countDocuments(status?: 'pending' | 'approved' | 'rejected') {
  const query = supabase.from('documents').select('*', { count: 'exact', head: true })
  const { count } = await (status ? query.eq('status', status) : query)
  return count ?? 0
}

async function countTable(table: 'approval_steps' | 'signatures' | 'profiles', status?: string) {
  const query = supabase.from(table).select('*', { count: 'exact', head: true })
  const { count } = await (status ? query.eq('status', status) : query)
  return count ?? 0
}

export function AdminReports() {
  const { profile: currentProfile } = useAuth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [feed, setFeed] = useState<AuditLogWithRelations[]>([])
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [chainBreaks, setChainBreaks] = useState<ChainBreak[] | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [roleUpdateError, setRoleUpdateError] = useState<string | null>(null)
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [committeeUpdateError, setCommitteeUpdateError] = useState<string | null>(null)
  const [updatingStudentId, setUpdatingStudentId] = useState<string | null>(null)

  const loadFeed = useCallback(async () => {
    const { data } = await supabase
      .from('audit_log')
      .select('*, actor:profiles(full_name), document:documents(title)')
      .order('seq', { ascending: false })
      .limit(100)
    setFeed((data as AuditLogWithRelations[]) ?? [])
  }, [])

  const loadUsers = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select(
        'id, full_name, email, role, created_at, advisor_id, committee_member_1_id, committee_member_2_id, committee_member_3_id, committee_member_4_id, committee_member_5_id, department_chair_id, graduate_school_id',
      )
      .order('created_at', { ascending: true })
    setUsers((data as Profile[]) ?? [])
  }, [])

  const loadStats = useCallback(async () => {
    const [
      documentsTotal,
      documentsPending,
      documentsApproved,
      documentsRejected,
      stepsOutstanding,
      signaturesTotal,
      usersTotal,
    ] = await Promise.all([
      countDocuments(),
      countDocuments('pending'),
      countDocuments('approved'),
      countDocuments('rejected'),
      countTable('approval_steps', 'pending'),
      countTable('signatures'),
      countTable('profiles'),
    ])
    setStats({
      documentsTotal,
      documentsPending,
      documentsApproved,
      documentsRejected,
      stepsOutstanding,
      signaturesTotal,
      usersTotal,
    })
  }, [])

  useEffect(() => {
    Promise.all([loadStats(), loadFeed(), loadUsers()]).finally(() => setLoading(false))

    const channel = supabase
      .channel('admin-reports')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_log' }, () => {
        loadFeed()
        loadStats()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadStats, loadFeed, loadUsers])

  async function handleRoleChange(userId: string, newRole: UserRole) {
    setRoleUpdateError(null)
    setUpdatingUserId(userId)
    const { error } = await supabase.rpc('promote_user_role', {
      p_user_id: userId,
      p_new_role: newRole,
    })
    setUpdatingUserId(null)
    if (error) {
      setRoleUpdateError(error.message)
      return
    }
    loadUsers()
    loadStats()
  }

  async function handleCommitteeChange(student: Profile, slot: CommitteeSlotKey, value: string) {
    setCommitteeUpdateError(null)
    setUpdatingStudentId(student.id)
    const { error } = await supabase.rpc('assign_thesis_committee', {
      p_student_id: student.id,
      p_advisor_id: slot === 'advisor_id' ? value || null : student.advisor_id,
      p_committee_member_1_id: slot === 'committee_member_1_id' ? value || null : student.committee_member_1_id,
      p_committee_member_2_id: slot === 'committee_member_2_id' ? value || null : student.committee_member_2_id,
      p_committee_member_3_id: slot === 'committee_member_3_id' ? value || null : student.committee_member_3_id,
      p_committee_member_4_id: slot === 'committee_member_4_id' ? value || null : student.committee_member_4_id,
      p_committee_member_5_id: slot === 'committee_member_5_id' ? value || null : student.committee_member_5_id,
      p_department_chair_id: slot === 'department_chair_id' ? value || null : student.department_chair_id,
      p_graduate_school_id: slot === 'graduate_school_id' ? value || null : student.graduate_school_id,
    })
    setUpdatingStudentId(null)
    if (error) {
      setCommitteeUpdateError(error.message)
      return
    }
    loadUsers()
  }

  async function handleVerifyChain() {
    setChecking(true)
    setCheckError(null)
    setChainBreaks(null)
    const { data, error } = await supabase.rpc('verify_audit_chain')
    setChecking(false)
    if (error) {
      setCheckError(error.message)
      return
    }
    setChainBreaks((data as ChainBreak[]) ?? [])
  }

  if (loading || !stats) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600"></div>
          <p className="mt-2 text-gray-600">Loading reports...</p>
        </div>
      </div>
    )
  }

  const eventIcon: Record<string, string> = {
    user_registered: '👤',
    user_login: '🔓',
    document_submitted: '📤',
    document_viewed: '👁️',
    approval_step_approved: '✓',
    approval_step_rejected: '✕',
    document_signed: '🔐',
    document_approved: '✓',
    document_rejected: '✕',
    user_role_changed: '🔧',
    signing_key_rotated: '🔑',
    thesis_committee_assigned: '🎓',
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">System Reports</h1>
        <p className="mt-2 text-gray-600">Audit logs, statistics, and integrity verification</p>
      </div>

      {/* Key Statistics */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span>📊</span> Key Statistics
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="📄 Documents" value={stats.documentsTotal} />
          <StatCard label="⏳ Pending" value={stats.documentsPending} color="yellow" />
          <StatCard label="✅ Approved" value={stats.documentsApproved} color="green" />
          <StatCard label="❌ Rejected" value={stats.documentsRejected} color="red" />
          <StatCard label="⏸ Outstanding" value={stats.stepsOutstanding} color="orange" />
          <StatCard label="🔐 Signatures" value={stats.signaturesTotal} color="blue" />
          <StatCard label="👥 Users" value={stats.usersTotal} color="purple" />
        </div>
      </div>

      {/* Audit Chain Integrity */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span>🔗</span> Audit Chain Integrity
          </h2>
          <button
            type="button"
            onClick={handleVerifyChain}
            disabled={checking}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {checking ? (
              <>
                <span className="inline-block animate-spin">⏳</span>
                Verifying...
              </>
            ) : (
              <>
                🔍 Run Integrity Check
              </>
            )}
          </button>
        </div>

        {checkError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800">
            <p className="font-medium">⚠ {checkError}</p>
          </div>
        )}

        {chainBreaks !== null && chainBreaks.length === 0 && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-4">
            <p className="text-green-800 font-medium">
              ✅ Chain Intact — No Tampering Detected
            </p>
            <p className="text-sm text-green-700 mt-1">
              All {feed.length} audit entries have valid hashes and intact chain links.
            </p>
          </div>
        )}

        {chainBreaks !== null && chainBreaks.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="font-medium text-red-800 mb-3">
              ⚠ Chain Breaks Detected: {chainBreaks.length} issue{chainBreaks.length !== 1 ? 's' : ''}
            </p>
            <ul className="space-y-2 text-red-700 text-sm">
              {chainBreaks.map((b) => (
                <li key={b.broken_seq} className="flex items-start gap-2">
                  <span className="text-red-500 font-bold">•</span>
                  <span>
                    <span className="font-semibold">Entry #{b.broken_seq}:</span> {b.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* User Management */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span>👥</span> User Management
        </h2>

        {roleUpdateError && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 text-red-800">
            <p className="font-medium">⚠ {roleUpdateError}</p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 pr-4 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 text-gray-900">{u.full_name}</td>
                  <td className="py-2 pr-4 text-gray-600">{u.email}</td>
                  <td className="py-2 pr-4">
                    {u.id === currentProfile?.id ? (
                      <span className="text-gray-500">{roleDisplayLabel(u.role)} (you)</span>
                    ) : (
                      <select
                        value={u.role}
                        disabled={updatingUserId === u.id}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                        className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
                      >
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {roleDisplayLabel(r)}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Thesis Committee Assignments */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span>🎓</span> Thesis Committee Assignments
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          Assign each student's fixed approval chain. A student cannot submit a thesis until all five slots are set.
        </p>

        {committeeUpdateError && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 text-red-800">
            <p className="font-medium">⚠ {committeeUpdateError}</p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4 font-medium">Student</th>
                {committeeSlots.map((slot) => (
                  <th key={slot.key} className="py-2 pr-4 font-medium">
                    {slot.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users
                .filter((u) => u.role === 'student')
                .map((student) => (
                  <tr key={student.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4 text-gray-900">{student.full_name}</td>
                    {committeeSlots.map((slot) => {
                      const candidates = users.filter((u) => u.role === slot.role)
                      return (
                        <td key={slot.key} className="py-2 pr-4">
                          <select
                            value={student[slot.key] ?? ''}
                            disabled={updatingStudentId === student.id}
                            onChange={(e) => handleCommitteeChange(student, slot.key, e.target.value)}
                            className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
                          >
                            <option value="">Not assigned</option>
                            {candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.full_name}
                              </option>
                            ))}
                          </select>
                        </td>
                      )
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Activity Feed */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span>📋</span> Recent Activity ({feed.length} entries)
        </h2>

        {feed.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <p className="text-gray-600">No audit entries yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {feed.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1">
                    <span className="text-xl mt-0.5 flex-shrink-0">
                      {eventIcon[entry.event_type] || '📝'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-gray-900">
                          {eventLabel[entry.event_type] || entry.event_type}
                        </p>
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                          #{entry.seq}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-gray-600 space-y-0.5">
                        {entry.actor && (
                          <p>
                            <span className="font-medium">{entry.actor.full_name}</span>
                          </p>
                        )}
                        {entry.document && (
                          <p className="text-gray-500">
                            Document: <span className="font-medium text-gray-700">{entry.document.title}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <p className="text-xs text-gray-500 font-mono">
                      {new Date(entry.created_at).toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400 mt-1 font-mono break-all max-w-xs">
                      {entry.entry_hash.slice(0, 12)}...
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  color = 'gray',
}: {
  label: string
  value: number
  color?: 'gray' | 'yellow' | 'green' | 'red' | 'orange' | 'blue' | 'purple'
}) {
  const colorClasses = {
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
  }

  return (
    <div className={`rounded-lg border p-4 text-center transition-all hover:shadow-md ${colorClasses[color]}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs font-medium mt-2">{label}</div>
    </div>
  )
}
