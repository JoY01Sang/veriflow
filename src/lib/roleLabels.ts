import type { Profile, UserRole } from '../types/auth'

// Roles eligible to be picked as a step in a thesis approval chain.
export const REVIEWER_ROLES: UserRole[] = [
  'advisor',
  'committee_member',
  'department_chair',
  'graduate_school',
  'registrar',
]

export function roleDisplayLabel(role: UserRole | null | undefined): string {
  switch (role) {
    case 'student':
      return 'Student'
    case 'advisor':
      return 'Advisor'
    case 'committee_member':
      return 'Committee Member'
    case 'department_chair':
      return 'Department Chair'
    case 'graduate_school':
      return 'Graduate School'
    case 'registrar':
      return 'Registrar'
    default:
      return ''
  }
}

export function profileRoleLabel(profile: Pick<Profile, 'role'> | null | undefined): string {
  return roleDisplayLabel(profile?.role)
}
