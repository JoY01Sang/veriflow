import { useAuth } from '../auth/useAuth'
import { REVIEWER_ROLES, profileRoleLabel } from '../lib/roleLabels'

export function Dashboard() {
  const { profile, session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600"></div>
          <p className="mt-2 text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-red-800 font-medium">⚠ Not logged in</p>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-red-800 font-medium">⚠ Profile not found</p>
        <p className="text-sm text-red-700 mt-2">Try logging out and back in.</p>
      </div>
    )
  }

  const roleEmoji = {
    student: '📤',
    advisor: '✓',
    committee_member: '✓',
    department_chair: '✓',
    graduate_school: '✓',
    registrar: '⚙️',
  }[profile.role] || '👤'

  const roleColor = {
    student: 'bg-blue-100 text-blue-800',
    advisor: 'bg-green-100 text-green-800',
    committee_member: 'bg-green-100 text-green-800',
    department_chair: 'bg-green-100 text-green-800',
    graduate_school: 'bg-green-100 text-green-800',
    registrar: 'bg-purple-100 text-purple-800',
  }[profile.role] || 'bg-gray-100 text-gray-800'

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Welcome, {profile.full_name.split(' ')[0]}! 👋</h1>
        <p className="mt-2 text-gray-600">Here's your Veriflow dashboard</p>
      </div>

      {/* Profile Card */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm mb-8">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Your Profile</h2>

        <div className="space-y-4">
          {/* Name */}
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-600">Full Name</p>
              <p className="text-lg font-medium text-gray-900">{profile.full_name}</p>
            </div>
            <span className="text-2xl">👤</span>
          </div>

          {/* Email */}
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-600">Email Address</p>
              <p className="text-lg font-medium text-gray-900">{profile.email}</p>
            </div>
            <span className="text-2xl">📧</span>
          </div>

          {/* Role */}
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-600">Account Type</p>
              <span className={`inline-block mt-1 rounded-full px-3 py-1 text-sm font-semibold ${roleColor}`}>
                {roleEmoji} {profileRoleLabel(profile)}
              </span>
            </div>
            <span className="text-2xl">{roleEmoji}</span>
          </div>

          {/* Created At */}
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-600">Member Since</p>
              <p className="text-lg font-medium text-gray-900">
                {new Date(profile.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
            <span className="text-2xl">📅</span>
          </div>
        </div>
      </div>

      {/* Quick Start Guide */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-6">
          <h3 className="font-semibold text-orange-900 mb-3">🚀 Getting Started</h3>
          <ul className="space-y-2 text-sm text-orange-800">
            <li>✓ Create and submit documents for approval</li>
            <li>✓ Review and digitally sign pending items</li>
            <li>✓ Verify document signatures and integrity</li>
            <li>✓ View complete audit trails</li>
          </ul>
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <h3 className="font-semibold text-blue-900 mb-3">🔒 Security Features</h3>
          <ul className="space-y-2 text-sm text-blue-800">
            <li>✓ RSA-PSS 2048-bit digital signatures</li>
            <li>✓ SHA-256 document hashing</li>
            <li>✓ Tamper detection capability</li>
            <li>✓ Complete audit logging</li>
          </ul>
        </div>
      </div>

      {/* Role-specific Tips */}
      {profile.role === 'student' && (
        <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6">
          <h3 className="font-semibold text-green-900 mb-2">💡 For Students</h3>
          <p className="text-sm text-green-800">
            Use the "Submit Document" section to submit your thesis. Select your advisor, committee members, department chair, and graduate school in order to build your approval chain. Your thesis will be digitally signed at each step.
          </p>
        </div>
      )}

      {REVIEWER_ROLES.includes(profile.role) && profile.role !== 'registrar' && (
        <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6">
          <h3 className="font-semibold text-green-900 mb-2">💡 For {profileRoleLabel(profile)}s</h3>
          <p className="text-sm text-green-800">
            Check "My Approvals" regularly for pending theses. Review, add comments, and sign documents using cryptographic signatures that prove authenticity.
          </p>
        </div>
      )}

      {profile.role === 'registrar' && (
        <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6">
          <h3 className="font-semibold text-green-900 mb-2">💡 For the Registrar</h3>
          <p className="text-sm text-green-800">
            Access the Reports section to view system-wide activity, verify document signatures, and audit all approval workflows across the university.
          </p>
        </div>
      )}
    </div>
  )
}
