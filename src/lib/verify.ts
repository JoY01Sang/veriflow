import { supabase } from './supabase'
import type { SignatureRecord } from '../types/documents'

export interface VerificationResult {
  /** The stored signature cryptographically matches the stored hash + public key. */
  signatureValid: boolean
  /** The document's current bytes still hash to what was signed (no tampering since signing). */
  hashMatches: boolean
}

export async function verifyDocumentSignature(
  filePath: string,
  signature: SignatureRecord,
): Promise<VerificationResult> {
  const { data: fileBlob, error } = await supabase.storage.from('documents').download(filePath)
  if (error || !fileBlob) throw new Error('Could not download document for verification')

  const fileBytes = new Uint8Array(await fileBlob.arrayBuffer())
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes)
  const hashHex = toHex(new Uint8Array(hashBuffer))
  const hashMatches = hashHex === signature.document_hash

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    signature.public_key_jwk,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signatureBytes = fromBase64(signature.signature_b64)
  const signatureValid = await crypto.subtle.verify(
    { name: 'RSA-PSS', saltLength: 32 },
    publicKey,
    signatureBytes,
    hashBuffer,
  )

  return { signatureValid, hashMatches }
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fromBase64(b64: string) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
