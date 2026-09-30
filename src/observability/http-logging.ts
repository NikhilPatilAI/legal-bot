import {
  LogController,
  type FastifyLoggerOptions,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

const safeMessages = new Set([
  'incoming request',
  'request completed',
  'request aborted',
  'request failed',
  'request rejected',
  'route not found',
  'response headers failed',
]);

/** URLs, headers, bodies and arbitrary error text are never request-log fields. */
export function httpLoggerOptions(): FastifyLoggerOptions & {
  redact: string[];
  serializers: NonNullable<FastifyLoggerOptions['serializers']> & {
    msg: (message: unknown) => string;
  };
} {
  return {
    level: 'info',
    serializers: {
      req: (request) => ({ method: request.method, id: request.id }),
      res: (reply) => ({ statusCode: reply.statusCode }),
      err: () => ({ type: 'Error', message: 'Request failed', stack: '' }),
      // Framework warnings can bypass LogController, and Pino derives msg from
      // err.message before applying the err serializer. Bound the final message
      // field as well; correlation, severity and status remain structured fields.
      msg: (message: unknown) =>
        typeof message === 'string' && safeMessages.has(message) ? message : 'HTTP event',
    },
    redact: [
      'req.headers',
      'req.body',
      'res.headers',
      'headers',
      '*.token',
      '*.password',
      '*.secret',
    ],
  };
}

/** Fastify's default messages include raw URLs and error.message outside serializers. */
export class SafeHttpLogController extends LogController {
  override defaultErrorLog(_error: Error, request: FastifyRequest, reply: FastifyReply) {
    if (this.isLogDisabled(request)) return;
    const event = { statusCode: reply.statusCode, requestId: request.id };
    if (reply.statusCode >= 500) reply.log.error(event, 'request failed');
    else reply.log.info(event, 'request rejected');
  }

  override routeNotFound(request: FastifyRequest) {
    if (!this.isLogDisabled(request)) request.log.info('route not found');
  }

  override writeHeadError(_error: Error, request: FastifyRequest, reply: FastifyReply) {
    if (!this.isLogDisabled(request))
      reply.log.warn({ requestId: request.id }, 'response headers failed');
  }
}
