export enum ResponseCodeStatus {
  PENDING = 'pending',
  // The proof finished; the verdict comes from the authenticated proof fetch, not from here.
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

export interface IResponseCodeResult {
  state: string;
  presentationId?: string;
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
