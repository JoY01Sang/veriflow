// Bulk test data generator for Veriflow.
//


import { readFileSync } from 'node:fs'
import { randomUUID, webcrypto as crypto } from 'node:crypto'
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

const SUBMITTERS: SeedUserSpec[] = [
  { fullName: 'Alice Student', email: 'seed.alice@veriflow.test', role: 'student' },
  { fullName: 'Bob Student', email: 'seed.bob@veriflow.test', role: 'student' },
  { fullName: 'Carol Student', email: 'seed.carol@veriflow.test', role: 'student' },
  { fullName: 'Dave Student', email: 'seed.dave@veriflow.test', role: 'student' },
]

const APPROVERS: SeedUserSpec[] = [
  { fullName: 'Erin Advisor', email: 'seed.erin@veriflow.test', role: 'advisor' },
  { fullName: 'Frank CommitteeMember', email: 'seed.frank@veriflow.test', role: 'committee_member' },
  { fullName: 'Grace DeptChair', email: 'seed.grace@veriflow.test', role: 'department_chair' },
  { fullName: 'Heidi GradSchool', email: 'seed.heidi@veriflow.test', role: 'graduate_school' },
]

// Created as a student (the new_user trigger refuses 'registrar' on signup by
// design); promote manually afterward with the SQL printed at the end.
const FUTURE_ADMIN: SeedUserSpec = {
  fullName: 'Iris FutureRegistrar',
  email: 'seed.iris@veriflow.test',
  role: 'student',
}

const DOCUMENT_TITLES = [
  'Q3 Budget Proposal',
  'Vendor Contract - Acme Corp',
  'Employee Handbook Revision',
  'NDA - Project Falcon',
  'Office Lease Renewal',
  'Marketing Campaign Brief',
  'Security Policy Update',
  'Travel Expense Report',
  'Software License Agreement',
  'Annual Compliance Report',
  'Partnership Term Sheet',
  'IT Infrastructure Upgrade Plan',
  'Customer Data Sharing Agreement',
  'Product Launch Checklist',
  'Facilities Maintenance Contract',
  'Remote Work Policy',
  'Supplier Onboarding Form',
  'Internal Audit Findings',
  'Capital Expenditure Request',
  'Data Retention Policy',
]

function daysAgo(days: number, hours = 0) {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000)
}

function pickRandom<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function shuffledSample<T>(arr: T[], count: number) {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64')
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

type SignerKeys = { privateKey: CryptoKey; publicJwk: JsonWebKey }
const signerKeyCache = new Map<string, SignerKeys>()

async function getOrCreateSigningKeys(userId: string): Promise<SignerKeys> {
  const cached = signerKeyCache.get(userId)
  if (cached) return cached

  const { data: existingPublic } = await admin
    .from('signing_public_keys')
    .select('public_key_jwk')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingPublic) {
    const { data: existingPrivate, error } = await admin
      .from('signing_private_keys')
      .select('private_key_jwk')
      .eq('user_id', userId)
      .single()
    if (error || !existingPrivate) throw new Error(`Signer ${userId} is missing its private key half`)
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      existingPrivate.private_key_jwk as JsonWebKey,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const keys = { privateKey, publicJwk: existingPublic.public_key_jwk as JsonWebKey }
    signerKeyCache.set(userId, keys)
    return keys
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

  const { error: pubErr } = await admin.from('signing_public_keys').insert({ user_id: userId, public_key_jwk: publicJwk })
  if (pubErr) throw new Error(`Failed to store public key for ${userId}: ${pubErr.message}`)
  const { error: privErr } = await admin.from('signing_private_keys').insert({ user_id: userId, private_key_jwk: privateJwk })
  if (privErr) throw new Error(`Failed to store private key for ${userId}: ${privErr.message}`)

  const keys = { privateKey: keyPair.privateKey, publicJwk }
  signerKeyCache.set(userId, keys)
  return keys
}

async function insertAuditLog(
  eventType: string,
  actorId: string | null,
  documentId: string | null,
  approvalStepId: string | null,
  metadata: Record<string, unknown>,
) {
  const { error } = await admin.rpc('insert_audit_log', {
    p_event_type: eventType,
    p_actor_id: actorId,
    p_document_id: documentId,
    p_approval_step_id: approvalStepId,
    p_metadata: metadata,
  })
  if (error) throw new Error(`insert_audit_log(${eventType}) failed: ${error.message}`)
}

type Outcome = 'left_pending' | 'approved' | 'rejected'

async function seedDocument(index: number, submitterId: string, approverIds: string[]) {
  const docId = randomUUID()
  const title = `${pickRandom(DOCUMENT_TITLES)} #${index}`
  const filePath = `${submitterId}/${docId}.txt`
  const createdAt = daysAgo(Math.floor(Math.random() * 30), Math.floor(Math.random() * 23))

  const fileBytes = new TextEncoder().encode(
    `Veriflow seed document\nTitle: ${title}\nSubmitted by: ${submitterId}\nSeed index: ${index}\nGenerated: ${createdAt.toISOString()}\n`,
  )

  const { error: uploadError } = await admin.storage
    .from('documents')
    .upload(filePath, fileBytes, { contentType: 'text/plain', upsert: true })
  if (uploadError) throw new Error(`Upload failed for ${filePath}: ${uploadError.message}`)

  const { error: docError } = await admin.from('documents').insert({
    id: docId,
    title,
    file_path: filePath,
    submitter_id: submitterId,
    status: 'pending',
    created_at: createdAt.toISOString(),
  })
  if (docError) throw new Error(`Document insert failed: ${docError.message}`)

  const steps = approverIds.map((approverId, i) => ({
    id: randomUUID(),
    document_id: docId,
    step_order: i + 1,
    approver_id: approverId,
    status: i === 0 ? 'pending' : 'waiting',
  }))
  const { error: stepsError } = await admin.from('approval_steps').insert(steps)
  if (stepsError) throw new Error(`Approval steps insert failed: ${stepsError.message}`)

  await insertAuditLog('document_submitted', submitterId, docId, null, {
    title,
    approver_count: steps.length,
  })

  // Decide how far the chain progresses: ~40% left pending at step 1,
  // ~25% rejected partway through, ~35% walked to full approval.
  const roll = Math.random()
  let outcome: Outcome = 'left_pending'
  if (roll < 0.4) outcome = 'left_pending'
  else if (roll < 0.65) outcome = 'rejected'
  else outcome = 'approved'

  if (outcome === 'left_pending') return outcome

  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes)
  const hashHex = Buffer.from(hashBuffer).toString('hex')

  const rejectAtStep = outcome === 'rejected' ? 1 + Math.floor(Math.random() * steps.length) : -1

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const acted = new Date(createdAt.getTime() + (i + 1) * 3_600_000 * (1 + Math.random() * 5))

    if (outcome === 'rejected' && step.step_order === rejectAtStep) {
      await admin
        .from('approval_steps')
        .update({ status: 'rejected', comment: 'Rejected during seed walkthrough.', acted_at: acted.toISOString() })
        .eq('id', step.id)
      await admin.from('documents').update({ status: 'rejected' }).eq('id', docId)
      await admin
        .from('approval_steps')
        .update({ status: 'skipped' })
        .eq('document_id', docId)
        .eq('status', 'waiting')
      await insertAuditLog('approval_step_rejected', step.approver_id, docId, step.id, {
        step_order: step.step_order,
        comment: 'Rejected during seed walkthrough.',
      })
      return outcome
    }

    // Approve this step: sign the file with this approver's key first.
    const { privateKey, publicJwk } = await getOrCreateSigningKeys(step.approver_id)
    const signatureBuffer = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, privateKey, hashBuffer)
    const { error: sigError } = await admin.from('signatures').insert({
      approval_step_id: step.id,
      document_id: docId,
      signer_id: step.approver_id,
      document_hash: hashHex,
      signature_b64: toBase64(new Uint8Array(signatureBuffer)),
      public_key_jwk: publicJwk,
    })
    if (sigError) throw new Error(`Signature insert failed: ${sigError.message}`)
    await insertAuditLog('document_signed', step.approver_id, docId, step.id, { document_hash: hashHex })

    const nextStep = steps[i + 1]
    await admin
      .from('approval_steps')
      .update({ status: 'approved', acted_at: acted.toISOString() })
      .eq('id', step.id)

    if (nextStep) {
      await admin.from('approval_steps').update({ status: 'pending' }).eq('id', nextStep.id)
      await insertAuditLog('approval_step_approved', step.approver_id, docId, step.id, {
        step_order: step.step_order,
        next_step: nextStep.step_order,
      })
    } else {
      await admin.from('documents').update({ status: 'approved' }).eq('id', docId)
      await insertAuditLog('document_approved', step.approver_id, docId, step.id, {
        final_step: step.step_order,
      })
    }
  }

  return outcome
}

async function main() {
  console.log('Creating users...')
  const submitterIds: string[] = []
  for (const spec of SUBMITTERS) submitterIds.push(await createSeedUser(spec))

  const approverIds: string[] = []
  for (const spec of APPROVERS) approverIds.push(await createSeedUser(spec))

  const futureAdminId = await createSeedUser(FUTURE_ADMIN)

  console.log('\nLogging a few user_login events...')
  for (const userId of [...submitterIds, ...approverIds, futureAdminId]) {
    const loginCount = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < loginCount; i++) {
      await insertAuditLog('user_login', userId, null, null, {})
    }
  }

  console.log('\nSeeding documents and approval workflows...')
  const tally = { left_pending: 0, approved: 0, rejected: 0 }
  const DOCUMENT_COUNT = 20
  for (let i = 1; i <= DOCUMENT_COUNT; i++) {
    const submitterId = pickRandom(submitterIds)
    const approverCount = 1 + Math.floor(Math.random() * 3)
    const chosenApprovers = shuffledSample(approverIds, approverCount)
    const outcome = await seedDocument(i, submitterId, chosenApprovers)
    tally[outcome]++
    console.log(`  [${i}/${DOCUMENT_COUNT}] -> ${outcome}`)
  }

  console.log('\nDone.')
  console.log(`Documents: ${tally.left_pending} pending, ${tally.approved} approved, ${tally.rejected} rejected`)
  console.log(`\nAll seed users share the password: ${SEED_PASSWORD}`)
  console.log('Submitters:', SUBMITTERS.map((u) => u.email).join(', '))
  console.log('Approvers:', APPROVERS.map((u) => u.email).join(', '))
  console.log('\nTo promote one seed user to registrar (intentionally not doable via the app), run in the Supabase SQL editor:')
  console.log(`  update public.profiles set role = 'registrar' where email = '${FUTURE_ADMIN.email}';`)
}

main().catch((err) => {
  console.error('\nSeed failed:', err)
  process.exit(1)
})
