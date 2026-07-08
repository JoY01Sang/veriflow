type ErrorContext = 'auth' | 'document' | 'approval' | 'storage' | 'database' | 'validation' | 'network' | 'unknown'

interface ErrorDetail {
  context: ErrorContext
  message: string
  originalError?: unknown
  timestamp: string
  userMessage: string
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    if ('message' in error) return String(error.message)
    if ('error' in error) return String(error.error)
  }
  return 'An unexpected error occurred'
}

function classifyError(error: unknown, context: ErrorContext): ErrorContext {
  const message = getErrorMessage(error)
  const messageLower = message.toLowerCase()

  if (messageLower.includes('auth') || messageLower.includes('unauthorized') || messageLower.includes('session'))
    return 'auth'
  if (messageLower.includes('network') || messageLower.includes('offline'))
    return 'network'
  if (messageLower.includes('validation') || messageLower.includes('invalid') || messageLower.includes('required'))
    return 'validation'
  if (messageLower.includes('storage') || messageLower.includes('bucket'))
    return 'storage'
  if (messageLower.includes('database') || messageLower.includes('query'))
    return 'database'

  return context
}

function getUserFriendlyMessage(context: ErrorContext, error: unknown): string {
  const message = getErrorMessage(error)
  const messageLower = message.toLowerCase()

  const messages: Record<ErrorContext, () => string> = {
    auth: () => {
      if (messageLower.includes('already registered')) return 'This email is already registered.'
      if (messageLower.includes('invalid')) return 'Invalid email or password.'
      if (messageLower.includes('not confirmed')) return 'Please confirm your email address.'
      return 'Authentication failed. Please try again.'
    },
    document: () => 'Failed to process document. Please try again.',
    approval: () => 'Failed to process approval. Please try again.',
    storage: () => 'Failed to upload file. Please check the file and try again.',
    database: () => 'Database operation failed. Please try again.',
    validation: () => `Invalid input: ${message}`,
    network: () => 'Network connection failed. Please check your connection and try again.',
    unknown: () => 'An unexpected error occurred. Please try again.',
  }

  return messages[context]()
}

export function handleError(error: unknown, context: ErrorContext = 'unknown'): ErrorDetail {
  const originalMessage = getErrorMessage(error)
  const classifiedContext = classifyError(error, context)
  const userMessage = getUserFriendlyMessage(classifiedContext, error)
  const timestamp = new Date().toISOString()

  const errorDetail: ErrorDetail = {
    context: classifiedContext,
    message: originalMessage,
    originalError: error,
    timestamp,
    userMessage,
  }

  logError(errorDetail)

  return errorDetail
}

function logError(detail: ErrorDetail): void {
  const prefix = `[${detail.timestamp}] ${detail.context.toUpperCase()}`

  if (import.meta.env.DEV) {
    console.group(`%c${prefix}`, 'color: #ff6b6b; font-weight: bold')
    console.error('Original Error:', detail.originalError)
    console.error('Message:', detail.message)
    console.error('User Message:', detail.userMessage)
    console.error('Context:', detail.context)
    console.groupEnd()
  } else {
    console.error(`${prefix}: ${detail.message}`)
  }
}

export function extractErrorMessage(error: unknown): string {
  return getErrorMessage(error)
}

export function isAuthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('auth') || message.includes('unauthorized') || message.includes('session')
}

export function isNetworkError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('network') || message.includes('offline') || message.includes('fetch')
}

export function isValidationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('validation') || message.includes('invalid') || message.includes('required')
}
