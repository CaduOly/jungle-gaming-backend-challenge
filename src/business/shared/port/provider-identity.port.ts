export interface AuthenticatedProvider {
  readonly providerId: string;
}

export interface IProviderIdentity {
  authenticate(credentials: string | undefined): Promise<AuthenticatedProvider>;
}
