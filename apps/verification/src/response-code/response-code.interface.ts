export enum ResponseCodeStatus {
  PENDING = 'pending',
  // The proof finished; the verdict comes from the authenticated proof fetch, not from here.
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

/** A proof outcome: completed, failed (refused or not verified), or expired (ran out unanswered). */
export type TerminalResponseCodeStatus =
  | ResponseCodeStatus.COMPLETED
  | ResponseCodeStatus.FAILED
  | ResponseCodeStatus.EXPIRED;

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

/**
 * What the NDI hosted page reads to show a request (HVP-SD §5.2). Created with the response_code session, only for a
 * request that carries a redirectUri, and lives one grace period longer than it.
 */
export interface IHostedSession {
  hostedId: string;
  orgId: string;
  threadId: string;
  /**
   * What the QR code encodes, never the deep link (DL-004): the scan link when HOSTED_SCAN_BASE_URL is set, otherwise
   * the bare invitation. Neither carries a returnUrl.
   */
  proofRequestURL: string;
  /** The agent's full `?oob=` invitation URL, before any shortening; the scan link answers with it. */
  oobUrl?: string;
  /**
   * The relying party's deep link, with returnUrl, for the "Open Bhutan NDI" button: the wallet opens returnUrl once
   * the proof completes, so the page does not redirect after it is tapped (E7, DL-007).
   */
  deepLinkURL?: string;
  /** redirectUri?response_code=..., only returned by /status once the proof is completed or failed. */
  returnUrl: string;
  redirectUri: string;
  returnHost: string;
  /** Links a later connection or handshake-reuse event to this session (DL-016). */
  outOfBandId?: string;
  /** The request's own deadline (DL-017). */
  expiresAt: string;
  /** Kept once the proof ends, so the page still learns it after the response_code is used. */
  outcome?: TerminalResponseCodeStatus;
}

/**
 * GET /verification/hosted/:hostedId. `redirectUri` carries no response_code (DL-013); `deepLinkURL` does (DL-007), so
 * the hostedId holder can exchange the code: see `attachHostedPage`.
 */
export interface IHostedPage {
  returnHost: string;
  redirectUri: string;
  proofRequestURL: string;
  deepLinkURL?: string;
  expiresAt: string;
}

export type HostedStatus = 'pending' | 'scanned' | 'completed' | 'failed' | 'expired';

/** GET /verification/hosted/:hostedId/status. returnUrl only while the result can still be exchanged. */
export interface IHostedStatus {
  status: HostedStatus;
  returnUrl?: string;
}
