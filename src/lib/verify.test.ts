import { describe, it, expect, vi } from 'vitest'
import type { SignatureRecord } from '../types/documents'

const downloadMock = vi.fn()

vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: () => ({ download: downloadMock }),
    },
  },
}))

const { verifyDocumentSignature } = await import('./verify')

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function signFile(bytes: Uint8Array) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const signatureBuffer = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, keyPair.privateKey, hashBuffer)
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

  const signature: SignatureRecord = {
    id: 'sig-1',
    approval_step_id: 'step-1',
    document_id: 'doc-1',
    signer_id: 'user-1',
    document_hash: hashHex,
    signature_b64: toBase64(new Uint8Array(signatureBuffer)),
    algorithm: 'RSA-PSS-SHA256',
    public_key_jwk: publicJwk as JsonWebKey,
    created_at: new Date().toISOString(),
  }
  return signature
}

describe('verifyDocumentSignature', () => {
  it('reports a valid signature and matching hash for an untampered file', async () => {
    const original = new TextEncoder().encode('the contents of the signed document')
    const signature = await signFile(original)
    downloadMock.mockResolvedValueOnce({ data: new Blob([original]), error: null })

    const result = await verifyDocumentSignature('some/path', signature)

    expect(result.hashMatches).toBe(true)
    expect(result.signatureValid).toBe(true)
  })

  it('detects tampering when the downloaded file no longer matches what was signed', async () => {
    const original = new TextEncoder().encode('the original contents')
    const signature = await signFile(original)
    const tampered = new TextEncoder().encode('the original contents, but altered')
    downloadMock.mockResolvedValueOnce({ data: new Blob([tampered]), error: null })

    const result = await verifyDocumentSignature('some/path', signature)

    expect(result.hashMatches).toBe(false)
    expect(result.signatureValid).toBe(false)
  })

  it('throws when the file cannot be downloaded', async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: new Error('not found') })

    await expect(
      verifyDocumentSignature('missing/path', {
        id: 'sig-1',
        approval_step_id: 'step-1',
        document_id: 'doc-1',
        signer_id: 'user-1',
        document_hash: 'deadbeef',
        signature_b64: '',
        algorithm: 'RSA-PSS-SHA256',
        public_key_jwk: {} as JsonWebKey,
        created_at: new Date().toISOString(),
      }),
    ).rejects.toThrow('Could not download document for verification')
  })
})
