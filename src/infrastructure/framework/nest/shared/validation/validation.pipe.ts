import { type ArgumentMetadata, Injectable, ValidationPipe } from '@nestjs/common';
import { detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { exceedsBodyDepth } from './body-depth';
import { forbiddenKeyDetails } from './forbidden-keys';
import { validationDetails } from './validation-details';

/**
 * Campo desconhecido é rejeitado (não descartado em silêncio), e cada campo reporta só a primeira regra que falhou.
 * Sem transform: primitivo nunca é convertido ("2" continua string para os pipes de param dedicados, e um amount
 * numérico continua number para falhar em MUST_BE_STRING em vez de virar money). Body aninhado demais é recusado
 * antes de qualquer coisa percorrer ele recursivamente, e body com chave de prototype antes do class-transformer ver.
 */
@Injectable()
export class RequestValidationPipe extends ValidationPipe {
  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: false,
      stopAtFirstError: true,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) => new HttpProblem(400, validationDetails(errors)),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (metadata.type === 'body') {
      if (exceedsBodyDepth(value)) throw new HttpProblem(400, [detail(ValidationDetailMessage.MALFORMED_BODY)]);
      const forbidden = forbiddenKeyDetails(value);
      if (forbidden.length > 0) throw new HttpProblem(400, forbidden);
    }
    return super.transform(value, metadata);
  }
}

export const createValidationPipe = (): ValidationPipe => new RequestValidationPipe();
