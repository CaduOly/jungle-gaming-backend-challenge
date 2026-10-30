import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = Symbol('IS_PUBLIC');

/** Abre uma rota ou controller: health, /i18n. Todo o resto exige provider. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
