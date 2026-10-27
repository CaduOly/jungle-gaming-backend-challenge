import { ValidationPipe } from '@nestjs/common';
import { HttpProblem } from '../errors/http-problem';
import { validationDetails } from './validation-details';

/** Unknown fields are rejected (not silently dropped), and every field reports its first failed rule only. */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new HttpProblem(400, validationDetails(errors)),
  });
