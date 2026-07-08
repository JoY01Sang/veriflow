// Deno Edge Function. Deploy with: supabase functions deploy sign-approval-step
//
// Signs a document on behalf of the approver acting on a pending approval
// step, then advances the workflow. The signing private key never leaves
// this function: it's generated on first use and stored in
// signing_private_keys, a table with row-level security enabled and no
// policies, so only the service role (used here) can ever read or write it.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ROLE_LABELS: Record<string, string> = {
  student: 'Student',
  advisor: 'Advisor',
  committee_member: 'Committee Member',
  department_chair: 'Department Chair',
  graduate_school: 'Graduate School',
  registrar: 'Registrar',
}

function log(level: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  const executionId = Deno.env.get('SB_EXECUTION_ID') || 'unknown'
  const logEntry: Record<string, unknown> = {
    timestamp,
    level,
    executionId,
    message,
  }
  if (data) logEntry.data = data
  console.log(JSON.stringify(logEntry))
}

Deno.serve(async (req) => {
  const executionId = Deno.env.get('SB_EXECUTION_ID') || 'unknown'

  try {
    log('INFO', `[${executionId}] Request started`, { method: req.method })

    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    // Parse request
    let p_step_id: string
    let p_comment: string | null
    try {
      const body = await req.json()
      p_step_id = body.p_step_id
      p_comment = body.p_comment || null
      log('INFO', `[${executionId}] Request parsed`, { p_step_id, hasComment: !!p_comment })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to parse request body`, { error: String(e) })
      throw new Error('Invalid request body')
    }

    if (!p_step_id) {
      log('ERROR', `[${executionId}] Missing p_step_id`)
      throw new Error('p_step_id is required')
    }

    // Get auth header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      log('ERROR', `[${executionId}] Missing Authorization header`)
      throw new Error('Missing Authorization header')
    }
    log('INFO', `[${executionId}] Authorization header found`)

    // Setup clients
    let supabaseUrl: string
    let anonKey: string
    let serviceKey: string
    try {
      // PROJECT_* overrides let us manually pin keys via `supabase secrets set`,
      // since Supabase rejects secrets named SUPABASE_* (reserved/auto-injected).
      supabaseUrl = (Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL'))!
      anonKey = (Deno.env.get('PROJECT_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY'))!
      serviceKey = (Deno.env.get('PROJECT_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))!
      if (!supabaseUrl || !anonKey || !serviceKey) {
        const missing = [
          !supabaseUrl && 'SUPABASE_URL',
          !anonKey && 'SUPABASE_ANON_KEY',
          !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
        ].filter(Boolean)
        throw new Error(`Missing Supabase environment variables: ${missing.join(', ')}`)
      }
      log('INFO', `[${executionId}] Environment variables loaded`)
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to load environment variables`, { error: String(e) })
      throw new Error('Server configuration error')
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const adminClient = createClient(supabaseUrl, serviceKey)
    log('INFO', `[${executionId}] Supabase clients created`)

    // Get authenticated user
    let userId: string
    try {
      const { data: userData, error: userError } = await userClient.auth.getUser()
      if (userError) {
        log('ERROR', `[${executionId}] Auth error`, { error: userError.message })
        throw new Error('Not authenticated')
      }
      if (!userData.user) {
        log('ERROR', `[${executionId}] No user in auth response`)
        throw new Error('Not authenticated')
      }
      userId = userData.user.id
      log('INFO', `[${executionId}] User authenticated`, { userId })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to get user`, { error: String(e) })
      throw new Error('Authentication failed')
    }

    // Get approval step
    let step: any
    try {
      const { data, error: stepError } = await adminClient
        .from('approval_steps')
        .select('*')
        .eq('id', p_step_id)
        .single()
      if (stepError) {
        log('ERROR', `[${executionId}] Step query error`, { stepError: stepError.message })
        throw new Error(`Approval step query failed: ${stepError.message}`)
      }
      if (!data) {
        log('ERROR', `[${executionId}] Approval step not found`, { p_step_id })
        throw new Error('Approval step not found')
      }
      step = data
      log('INFO', `[${executionId}] Approval step loaded`, { stepId: step.id, status: step.status })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to get approval step`, { error: String(e) })
      throw e instanceof Error ? e : new Error('Step lookup failed')
    }

    // Validate authorization
    if (step.approver_id !== userId) {
      log('ERROR', `[${executionId}] Authorization check failed`, {
        stepApproverId: step.approver_id,
        userId
      })
      throw new Error('Not authorized to act on this step')
    }
    if (step.status !== 'pending') {
      log('ERROR', `[${executionId}] Step status not pending`, { status: step.status })
      throw new Error('This step is not currently actionable')
    }
    log('INFO', `[${executionId}] Authorization checks passed`)

    // Get document
    let document: any
    try {
      const { data, error: docError } = await adminClient
        .from('documents')
        .select('*')
        .eq('id', step.document_id)
        .single()
      if (docError) {
        log('ERROR', `[${executionId}] Document query error`, { docError: docError.message })
        throw new Error(`Document query failed: ${docError.message}`)
      }
      if (!data) {
        log('ERROR', `[${executionId}] Document not found`, { documentId: step.document_id })
        throw new Error('Document not found')
      }
      document = data
      log('INFO', `[${executionId}] Document loaded`, { documentId: document.id })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to get document`, { error: String(e) })
      throw e instanceof Error ? e : new Error('Document lookup failed')
    }

    // Download file
    let fileBlob: Blob
    try {
      const { data, error: downloadError } = await adminClient.storage
        .from('documents')
        .download(document.file_path)
      if (downloadError) {
        log('ERROR', `[${executionId}] File download error`, {
          filePath: document.file_path,
          error: downloadError.message
        })
        throw new Error(`File download failed: ${downloadError.message}`)
      }
      if (!data) {
        log('ERROR', `[${executionId}] No file data returned`)
        throw new Error('Could not read document file')
      }
      fileBlob = data
      log('INFO', `[${executionId}] File downloaded`, { filePath: document.file_path })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to download file`, { error: String(e) })
      throw e instanceof Error ? e : new Error('File download failed')
    }

    // Hash file
    let hashHex: string
    try {
      const fileBytes = new Uint8Array(await fileBlob.arrayBuffer())
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes)
      hashHex = toHex(new Uint8Array(hashBuffer))
      log('INFO', `[${executionId}] File hashed`, { hash: hashHex.slice(0, 16) + '...' })
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to hash file`, { error: String(e) })
      throw new Error('File hashing failed')
    }

    // Get or create key pair
    let privateKey: CryptoKey
    let publicJwk: any
    try {
      const result = await getOrCreateKeyPair(adminClient, userId, executionId)
      privateKey = result.privateKey
      publicJwk = result.publicJwk
      log('INFO', `[${executionId}] Key pair ready`)
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to get/create key pair`, { error: String(e) })
      throw e instanceof Error ? e : new Error('Key pair operation failed')
    }

    // Sign hash
    let signatureB64: string
    try {
      const fileBytes = new Uint8Array(await fileBlob.arrayBuffer())
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes)
      const signatureBuffer = await crypto.subtle.sign(
        { name: 'RSA-PSS', saltLength: 32 },
        privateKey,
        hashBuffer,
      )
      signatureB64 = toBase64(new Uint8Array(signatureBuffer))
      log('INFO', `[${executionId}] Document signed`)
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to sign document`, { error: String(e) })
      throw new Error('Document signing failed')
    }

    // Store signature
    try {
      const { error: insertError } = await adminClient.from('signatures').insert({
        approval_step_id: step.id,
        document_id: document.id,
        signer_id: userId,
        document_hash: hashHex,
        signature_b64: signatureB64,
        public_key_jwk: publicJwk,
      })
      if (insertError) {
        log('ERROR', `[${executionId}] Failed to insert signature`, {
          error: insertError.message
        })
        throw new Error(`Failed to store signature: ${insertError.message}`)
      }
      log('INFO', `[${executionId}] Signature stored`)
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to store signature`, { error: String(e) })
      throw e instanceof Error ? e : new Error('Signature storage failed')
    }

    // Log audit event
    try {
      await adminClient.rpc('insert_audit_log', {
        p_event_type: 'document_signed',
        p_actor_id: userId,
        p_document_id: document.id,
        p_approval_step_id: step.id,
        p_metadata: { document_hash: hashHex },
      })
      log('INFO', `[${executionId}] Audit event logged`)
    } catch (e) {
      log('WARN', `[${executionId}] Failed to log audit event`, { error: String(e) })
      // Don't throw - audit logging failure shouldn't block approval
    }

    // Approve step
    try {
      const { error: rpcError } = await userClient.rpc('act_on_approval_step', {
        p_step_id,
        p_decision: 'approved',
        p_comment: p_comment ?? null,
      })
      if (rpcError) {
        log('ERROR', `[${executionId}] RPC act_on_approval_step failed`, {
          error: rpcError.message
        })
        throw new Error(rpcError.message)
      }
      log('INFO', `[${executionId}] Approval step advanced`)
    } catch (e) {
      log('ERROR', `[${executionId}] Failed to approve step`, { error: String(e) })
      throw e instanceof Error ? e : new Error('Approval step advancement failed')
    }

    // Generate a cosmetic signature certificate copy: a visual record of
    // signers so far, appended as a new page onto a COPY of the document.
    // This never touches document.file_path -- verifyDocumentSignature
    // (src/lib/verify.ts) re-hashes exactly that path against each stored
    // signature, so mutating it would make every past signature look
    // tampered. Best-effort only: a non-PDF upload or any failure here must
    // not undo the approval that already succeeded above.
    try {
      const { data: approvedSteps } = await adminClient
        .from('approval_steps')
        .select('*')
        .eq('document_id', document.id)
        .eq('status', 'approved')
        .order('step_order', { ascending: true })

      const approverIds = (approvedSteps ?? []).map((s: any) => s.approver_id)
      const { data: approverProfiles } = await adminClient
        .from('profiles')
        .select('id, full_name, role')
        .in('id', approverIds)
      const profileMap = new Map((approverProfiles ?? []).map((p: any) => [p.id, p]))

      const pdfDoc = await PDFDocument.load(await fileBlob.arrayBuffer())
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
      const page = pdfDoc.addPage()
      const { height } = page.getSize()
      let y = height - 60

      function drawLine(text: string, size = 11, bold = false, gray = false) {
        page.drawText(text, {
          x: 50,
          y,
          size,
          font: bold ? boldFont : font,
          color: gray ? rgb(0.4, 0.4, 0.4) : rgb(0, 0, 0),
        })
        y -= size + 10
      }

      drawLine('Digital Signature Certificate', 16, true)
      y -= 6
      drawLine(`Document: ${document.title}`)
      drawLine(`SHA-256 hash: ${hashHex}`, 9)
      y -= 10
      drawLine('Approval chain:', 11, true)
      for (const step of approvedSteps ?? []) {
        const approver = profileMap.get(step.approver_id)
        const roleLabel = ROLE_LABELS[approver?.role] ?? approver?.role ?? 'Reviewer'
        const when = step.acted_at ? new Date(step.acted_at).toLocaleString() : ''
        drawLine(`${step.step_order}. ${roleLabel} — ${approver?.full_name ?? 'Unknown'} — approved ${when}`)
      }
      y -= 16
      drawLine('This page is a visual record only. Cryptographic verification happens in Veriflow,', 9, false, true)
      drawLine('not by inspecting this page.', 9, false, true)

      const stampedBytes = await pdfDoc.save()

      const lastSlash = document.file_path.lastIndexOf('/')
      const folder = document.file_path.slice(0, lastSlash)
      const filename = document.file_path.slice(lastSlash + 1)
      const certifiedPath = `${folder}/certified-${filename}`

      const { error: uploadError } = await adminClient.storage
        .from('documents')
        .upload(certifiedPath, stampedBytes, { contentType: 'application/pdf', upsert: true })
      if (uploadError) throw new Error(uploadError.message)

      const { error: updateError } = await adminClient
        .from('documents')
        .update({ certified_file_path: certifiedPath })
        .eq('id', document.id)
      if (updateError) throw new Error(updateError.message)

      log('INFO', `[${executionId}] Certificate copy generated`, { certifiedPath })
    } catch (e) {
      log('WARN', `[${executionId}] Failed to generate certificate copy (non-fatal)`, { error: String(e) })
    }

    log('INFO', `[${executionId}] Request completed successfully`)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log('ERROR', `[${executionId}] Request failed with error`, { error: message })
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

// deno-lint-ignore no-explicit-any
async function getOrCreateKeyPair(adminClient: any, userId: string, executionId: string) {
  try {
    log('INFO', `[${executionId}] Checking for existing key pair`)
    const { data: existingPublic } = await adminClient
      .from('signing_public_keys')
      .select('public_key_jwk')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingPublic) {
      log('INFO', `[${executionId}] Public key found, loading private key`)
      const { data: existingPrivate, error } = await adminClient
        .from('signing_private_keys')
        .select('private_key_jwk')
        .eq('user_id', userId)
        .single()
      if (error) {
        log('ERROR', `[${executionId}] Failed to load private key`, { error: error.message })
        throw new Error('Signing key is missing its private half')
      }
      if (!existingPrivate) {
        log('ERROR', `[${executionId}] Private key not found`)
        throw new Error('Signing key is missing its private half')
      }

      const privateKey = await crypto.subtle.importKey(
        'jwk',
        existingPrivate.private_key_jwk,
        { name: 'RSA-PSS', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      log('INFO', `[${executionId}] Existing key pair loaded`)
      return { privateKey, publicJwk: existingPublic.public_key_jwk }
    }

    log('INFO', `[${executionId}] Generating new key pair`)
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-PSS',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    log('INFO', `[${executionId}] Key pair generated, exporting to JWK`)

    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    log('INFO', `[${executionId}] Storing public key`)
    const { error: publicInsertError } = await adminClient
      .from('signing_public_keys')
      .insert({ user_id: userId, public_key_jwk: publicJwk })
    if (publicInsertError) {
      log('ERROR', `[${executionId}] Failed to store public key`, {
        error: publicInsertError.message
      })
      throw new Error(`Failed to store public key: ${publicInsertError.message}`)
    }

    log('INFO', `[${executionId}] Storing private key`)
    const { error: privateInsertError } = await adminClient
      .from('signing_private_keys')
      .insert({ user_id: userId, private_key_jwk: privateJwk })
    if (privateInsertError) {
      log('ERROR', `[${executionId}] Failed to store private key`, {
        error: privateInsertError.message
      })
      throw new Error(`Failed to store private key: ${privateInsertError.message}`)
    }

    log('INFO', `[${executionId}] New key pair stored successfully`)
    return { privateKey: keyPair.privateKey, publicJwk }
  } catch (e) {
    log('ERROR', `[${executionId}] Key pair operation failed`, { error: String(e) })
    throw e
  }
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
