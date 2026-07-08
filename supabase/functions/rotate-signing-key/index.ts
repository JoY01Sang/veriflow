// Deno Edge Function. Deploy with: supabase functions deploy rotate-signing-key
//
// Lets a user replace their own RSA signing key pair (e.g. if it may have
// been compromised). Safe to do at any time: every past signature stores a
// snapshot of the public key it was made with (see signatures.public_key_jwk
// in 0003_module3_signatures.sql), so rotating here can never invalidate or
// change what an old signature verifies against -- only future signatures
// use the new key.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function log(level: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  const executionId = Deno.env.get('SB_EXECUTION_ID') || 'unknown'
  const logEntry: Record<string, unknown> = { timestamp, level, executionId, message }
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

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing Authorization header')
    }

    const supabaseUrl = (Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL'))!
    const anonKey = (Deno.env.get('PROJECT_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY'))!
    const serviceKey = (Deno.env.get('PROJECT_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))!
    if (!supabaseUrl || !anonKey || !serviceKey) {
      throw new Error('Server configuration error')
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const adminClient = createClient(supabaseUrl, serviceKey)

    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) {
      throw new Error('Not authenticated')
    }
    const userId = userData.user.id
    log('INFO', `[${executionId}] User authenticated`, { userId })

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
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
    log('INFO', `[${executionId}] New key pair generated`)

    const { error: publicUpsertError } = await adminClient
      .from('signing_public_keys')
      .upsert({ user_id: userId, public_key_jwk: publicJwk })
    if (publicUpsertError) {
      throw new Error(`Failed to store public key: ${publicUpsertError.message}`)
    }

    const { error: privateUpsertError } = await adminClient
      .from('signing_private_keys')
      .upsert({ user_id: userId, private_key_jwk: privateJwk })
    if (privateUpsertError) {
      throw new Error(`Failed to store private key: ${privateUpsertError.message}`)
    }
    log('INFO', `[${executionId}] Key pair rotated and stored`)

    try {
      await adminClient.rpc('insert_audit_log', {
        p_event_type: 'signing_key_rotated',
        p_actor_id: userId,
        p_document_id: null,
        p_approval_step_id: null,
        p_metadata: {},
      })
    } catch (e) {
      log('WARN', `[${executionId}] Failed to log audit event`, { error: String(e) })
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
