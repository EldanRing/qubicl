export class QubiclError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'QubiclError';
  }
}

export function errorPayload(error: unknown): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  if (error instanceof QubiclError) {
    return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
  }
  return { error: { code: 'internal_error', message: 'The computer encountered an internal error.' } };
}
