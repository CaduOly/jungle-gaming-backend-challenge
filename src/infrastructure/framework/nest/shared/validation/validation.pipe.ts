import { type ArgumentMetadata, Injectable, ValidationPipe } from '@nestjs/common';
import { detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { exceedsBodyDepth } from './body-depth';
import { forbiddenKeyDetails } from './forbidden-keys';
import { validationDetails } from './validation-details';

/**
 * Unknown fields are rejected (not silently dropped), and every field reports its first failed rule only.
 * No transform: primitives are never coerced ("2" stays a string for the dedicated param pipes, and a numeric
 * amount stays a number so it fails MUST_BE_STRING instead of becoming money). A body nested too deep is refused
 * before anything walks it recursively, and one with a prototype key before class-transformer sees it.
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
