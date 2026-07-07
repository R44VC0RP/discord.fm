export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function invariant(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
