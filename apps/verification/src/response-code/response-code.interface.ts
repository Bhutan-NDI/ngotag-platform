export enum ResponseCodeStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

export interface IResponseCodeResult {
  state: string;
  isVerified: boolean;
  presentationId?: string;
  errorMessage?: string;
}

export interface IResponseCodeSession {
  orgId: string;
  threadId: string;
  redirectUri: string;
  status: ResponseCodeStatus;
  result?: IResponseCodeResult;
  createdAt: string;
}

export interface IProofCallbackResult {
  status: ResponseCodeStatus;
  threadId?: string;
  result?: IResponseCodeResult;
}
