/**
 * Maps a raw backend/network error message to a typed error class plus the
 * recovery action the UI should offer (open settings, retry, compact context…).
 */

export function classifyError(message: string): {
  errorType:
    | 'connection'
    | 'auth'
    | 'model'
    | 'timeout'
    | 'rate_limit'
    | 'server_error'
    | 'content_policy'
    | 'token_limit'
    | 'unknown';
  errorAction?: string;
  errorActionCommand?: 'openSettings' | 'runCommand' | 'reconnect' | 'compactContext' | 'retry';
} {
  const lower = message.toLowerCase();
  // BackendConfigError: permanent configuration failure (wrong key, backend not running).
  // Must be checked before the generic auth/connection patterns since its message embeds
  // both "configuration error" AND the original error text (which would also match those).
  if (lower.includes('configuration error')) {
    return { errorType: 'auth', errorAction: 'Open Settings', errorActionCommand: 'openSettings' };
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eaddrnotavail') ||
    lower.includes('ehostunreach') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return { errorType: 'connection', errorAction: 'Check Connection', errorActionCommand: 'openSettings' };
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { errorType: 'rate_limit', errorAction: 'Wait and Retry', errorActionCommand: 'retry' };
  }
  if (
    lower.includes('content_policy') ||
    lower.includes('content policy') ||
    lower.includes('safety') ||
    lower.includes('flagged')
  ) {
    return { errorType: 'content_policy' };
  }
  if (
    lower.includes('token') &&
    (lower.includes('limit') || lower.includes('exceed') || lower.includes('too long') || lower.includes('maximum'))
  ) {
    return { errorType: 'token_limit', errorAction: 'Reduce Context', errorActionCommand: 'compactContext' };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return { errorType: 'auth', errorAction: 'Check API Key', errorActionCommand: 'openSettings' };
  }
  if (lower.includes('404') && (lower.includes('model') || lower.includes('not found'))) {
    return { errorType: 'model', errorAction: 'Install Model' };
  }
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return { errorType: 'server_error', errorAction: 'Retry', errorActionCommand: 'retry' };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return { errorType: 'timeout', errorAction: 'Retry', errorActionCommand: 'retry' };
  }
  return { errorType: 'unknown', errorAction: 'Retry', errorActionCommand: 'retry' };
}
