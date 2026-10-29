export type DetailType = 'error' | 'warning';

/** One catalog entry: `code` is what clients branch on, `message` the i18n key the front end translates. */
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
