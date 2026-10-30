export type DetailType = 'error' | 'warning';

/** Uma entrada do catálogo: `code` é o que o client usa para decidir, `message` é a chave i18n que o front traduz. */
export interface IDetailMessage {
  readonly code: string;
  readonly message: string;
  readonly type: DetailType;
}

export const error = (namespace: string, code: string): IDetailMessage => ({
  code,
  message: `${namespace}.ERROR.${code}`,
  type: 'error',
});

export const warning = (namespace: string, code: string): IDetailMessage => ({
  code,
  message: `${namespace}.WARNING.${code}`,
  type: 'warning',
});
