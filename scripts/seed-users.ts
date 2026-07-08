// Creates test user accounts only (no documents/committee assignments/audit
// data) -- for when you want to seed accounts and build out test data by
// hand afterward. See scripts/seed.ts for the full workflow generator this
// was split out of.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadDotEnvValue(key: string): string | undefined {
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
      if (match && match[1] === key) return match[2].trim()
    }
  } catch {
    // .env not present; fall through to process.env
  }
  return undefined
}

const supabaseUrl = process.env.VITE_SUPABASE_URL || loadDotEnvValue('VITE_SUPABASE_URL')
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl) {
  throw new Error('VITE_SUPABASE_URL not found in .env or environment')
}
if (!serviceRoleKey) {
  throw new Error(
    'SUPABASE_SERVICE_ROLE_KEY is not set. Export it in your shell first:\n' +
      '  $env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"',
  )
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SEED_PASSWORD = 'SeedTest123!'

type SeedUserSpec = {
  fullName: string
  email: string
  role: 'student' | 'advisor' | 'committee_member' | 'department_chair' | 'graduate_school'
}

const USERS: SeedUserSpec[] = [
  { fullName: 'Alice Student', email: 'seed.alice@veriflow.test', role: 'student' },
  { fullName: 'Bob Student', email: 'seed.bob@veriflow.test', role: 'student' },
  { fullName: 'Carol Student', email: 'seed.carol@veriflow.test', role: 'student' },

  { fullName: 'Erin Advisor', email: 'seed.erin@veriflow.test', role: 'advisor' },
  { fullName: 'Frank Advisor', email: 'seed.frank@veriflow.test', role: 'advisor' },

  { fullName: 'Grace CommitteeMember', email: 'seed.grace@veriflow.test', role: 'committee_member' },
  { fullName: 'Heidi CommitteeMember', email: 'seed.heidi@veriflow.test', role: 'committee_member' },
  { fullName: 'Ivan CommitteeMember', email: 'seed.ivan@veriflow.test', role: 'committee_member' },

  { fullName: 'Judy DeptChair', email: 'seed.judy@veriflow.test', role: 'department_chair' },
  { fullName: 'Karl GradSchool', email: 'seed.karl@veriflow.test', role: 'graduate_school' },
]

// Created as a student (the new_user trigger refuses 'registrar' on signup
// by design) -- promote manually afterward with the SQL printed at the end.
const FUTURE_REGISTRAR: SeedUserSpec = {
  fullName: 'Liam FutureRegistrar',
  email: 'seed.liam@veriflow.test',
  role: 'student',
}

async function createSeedUser(spec: SeedUserSpec): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: spec.email,
    password: SEED_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: spec.fullName, requested_role: spec.role },
  })
  if (error) {
    if (error.message.toLowerCase().includes('already been registered')) {
      const { data: list } = await admin.auth.admin.listUsers()
      const existing = list.users.find((u) => u.email === spec.email)
      if (existing) {
        console.log(`  ~ reusing existing user ${spec.email}`)
        return existing.id
      }
    }
    throw new Error(`Failed to create ${spec.email}: ${error.message}`)
  }
  console.log(`  + created ${spec.email} (${spec.role})`)
  return data.user.id
}

async function main() {
  console.log('Creating users...')
  for (const spec of USERS) await createSeedUser(spec)
  await createSeedUser(FUTURE_REGISTRAR)

  console.log(`\nAll seed users share the password: ${SEED_PASSWORD}`)
  console.log(USERS.map((u) => `  ${u.email} (${u.role})`).join('\n'))
  console.log(`  ${FUTURE_REGISTRAR.email} (student, promote to registrar below)`)

  console.log(
    '\nTo promote the future registrar, run this in the Supabase SQL editor (must run together, ' +
      'in one transaction, since profiles.role is trigger-protected):',
  )
  console.log('  begin;')
  console.log("  select set_config('app.bypass_role_lock', 'true', true);")
  console.log(`  update public.profiles set role = 'registrar' where email = '${FUTURE_REGISTRAR.email}';`)
  console.log('  commit;')
}

main().catch((err) => {
  console.error('\nSeed failed:', err)
  process.exit(1)
})
