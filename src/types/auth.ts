export type UserRole =
  | 'student'
  | 'advisor'
  | 'committee_member'
  | 'department_chair'
  | 'graduate_school'
  | 'registrar'

export interface Profile {
  id: string
  full_name: string
  email: string
  role: UserRole
  created_at: string
  advisor_id: string | null
  committee_member_1_id: string | null
  committee_member_2_id: string | null
  committee_member_3_id: string | null
  committee_member_4_id: string | null
  committee_member_5_id: string | null
  department_chair_id: string | null
  graduate_school_id: string | null
}
