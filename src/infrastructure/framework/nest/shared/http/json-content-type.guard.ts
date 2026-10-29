import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

const JSON_TYPE = 'application/json';

const carriesBody = (request: Request): boolean => {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return length !== undefined && length !== '0';
};

/**
 * Guards the routes that read a body: the API only reads JSON. A request that carries a body in any other media
 * type answers 415 instead of reaching validation with an empty body (which would read as "every field is missing").
 * Routes without a body (the GETs, the reconciliation) do not use it and ignore whatever body arrives.
 */
@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (carriesBody(request) && !request.is(JSON_TYPE)) {
      throw new HttpProblem(415, [detail(ValidationDetailMessage.UNSUPPORTED_MEDIA_TYPE)]);
    }
    return true;
  }
}
