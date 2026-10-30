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
 * Protege as rotas que leem body, já que a API só lê JSON. Request com body em qualquer outro media type responde
 * 415 em vez de chegar na validação com body vazio (que ia aparecer como "todos os campos faltando").
 * Rotas sem body (os GETs, a reconciliação) não usam ele e ignoram qualquer body que chegar.
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
