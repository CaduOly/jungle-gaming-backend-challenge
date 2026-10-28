import { ValidationPipe } from '@nestjs/common';
import { HttpProblem } from '../errors/http-problem';
import { validationDetails } from './validation-details';

/**
 * Unknown fields are rejected (not silently dropped), and every field reports its first failed rule only.
 * No transform: primitives are never coerced ("2" stays a string for the dedicated param pipes, and a numeric
 * amount stays a number so it fails MUST_BE_STRING instead of becoming money).
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: false,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new HttpProblem(400, validationDetails(errors)),
  });
