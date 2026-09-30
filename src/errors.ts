export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: unknown;
}

export function toProblem(
  error: unknown,
  requestId: string,
  instance: string,
  production: boolean,
): ProblemDocument {
  if (error instanceof AppError) {
    return {
      type: `urn:legal-bot:problem:${error.code.replaceAll('_', '-')}`,
      title: error.message,
      status: error.statusCode,
      detail: error.message,
      instance,
      code: error.code,
      requestId,
      ...(error.details === undefined ? {} : { errors: error.details }),
    };
  }
  return {
    type: 'urn:legal-bot:problem:internal-error',
    title: 'Internal server error',
    status: 500,
    detail: production
      ? 'The request could not be completed.'
      : error instanceof Error
        ? error.message
        : 'Unknown error',
    instance,
    code: 'internal_error',
    requestId,
  };
}
