/* eslint-disable camelcase */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  IProofRequestSearchCriteria,
  IGetProofPresentationById,
  IProofPresentation,
  IProofRequestPayload,
  IRequestProof,
  ISendProofRequestPayload,
  IVerifyPresentation,
  IVerifiedProofData,
  IInvitation,
  IProofRequestData,
  IEmailResponse,
  IProofPresentationByThread
} from './interfaces/verification.interface';
import { VerificationRepository } from './repositories/verification.repository';
import { ATTRIBUTE_NAME_REGEX, CommonConstants } from '@credebl/common/common.constant';
import { getMaxProofRequestExpiresInSeconds } from '@credebl/common/proof-request-expiry';
import { resolveHttpStatus } from '@credebl/common/exception-normalisation';
import { RecordType, org_agents, organisation, presentations, user } from '@prisma/client';
import { additionalInvitationDidsField, ReuseInvitationDids } from '@credebl/common/invitation-dids';
import { AutoAccept, VerificationProcessState } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import * as QRCode from 'qrcode';
import { OutOfBandVerification } from '../templates/out-of-band-verification.template';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { IUserRequest } from '@credebl/user-request/user-request.interface';
import {
  IProofPresentationDetails,
  IProofPresentationList,
  IVerificationRecords
} from '@credebl/common/interfaces/verification.interface';
import {
  API_Version,
  ProofRequestLabel,
  ProofRequestType,
  ProofVersion,
  ProtocolVersionType
} from 'apps/api-gateway/src/verification/enum/verification.enum';
import { UserActivityService } from '@credebl/user-activity';
import { convertUrlToDeepLinkUrl, getAgentUrl } from '@credebl/common/common.utils';
import { UserActivityRepository } from 'libs/user-activity/repositories';
import { ISchemaDetail } from '@credebl/common/interfaces/schema.interface';
import { NATSClient } from '@credebl/common/NATSClient';
import { EmailService } from '@credebl/common/email.service';
import { ProofResponseCodeService, REQUEST_DEADLINE_GRACE_SECONDS } from './response-code/proof-response-code.service';
import {
  appendReturnUrl,
  buildReturnUrl,
  hasAllowedRedirectProtocol,
  isHttpRedirectUriAllowed,
  isRedirectUriAllowed,
  parseRedirectUriAllowlist,
  toTerminalResponseCodeStatus
} from './response-code/redirect-uri.util';
import {
  IHostedPage,
  IHostedSession,
  IHostedStatus,
  IProofCallbackResult,
  ResponseCodeStatus
} from './response-code/response-code.interface';

/**
 * The agent-controller value for `expiresInSeconds`: null or absent becomes undefined, so the field is
 * left out of the request and agent-controller applies its deployment default (DIDCOMM_PROOF_REQUEST_EXPIRY).
 */
const toAgentExpiresInSeconds = (value: number | null | undefined): number | undefined => value ?? undefined;

/**
 * Lifetime given to a same-device redirect request when the relying party sets none. The platform does not know the
 * agent's deployment default, so a redirect request always carries its own deadline and its response_code session can
 * be sized to match. Capped at PROOF_REQUEST_EXPIRY_MAX_SECONDS so a deployment with a low purge ceiling still accepts it.
 */
export const REDIRECT_DEFAULT_EXPIRES_IN_SECONDS = 600;

/** Status reads allowed per hosted page per minute; the page polls every 2-5 s (DL-008). */
const DEFAULT_HOSTED_STATUS_READS_PER_MINUTE = 60;

function hostedStatusReadsPerMinute(): number {
  const value = Number(process.env.HOSTED_STATUS_RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(value) && 0 < value ? value : DEFAULT_HOSTED_STATUS_READS_PER_MINUTE;
}

/** Where the NDI hosted page is served, e.g. https://id.bhutanndi.com (DL-012). Unset: no hosted page. */
function hostedPageBaseUrl(): string | undefined {
  return process.env.HOSTED_PAGE_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
}

function redirectDefaultExpiresInSeconds(): number {
  return Math.min(REDIRECT_DEFAULT_EXPIRES_IN_SECONDS, getMaxProofRequestExpiresInSeconds());
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger('VerificationService');

  constructor(
    @Inject('NATS_CLIENT') private readonly verificationServiceProxy: ClientProxy,
    private readonly verificationRepository: VerificationRepository,
    private readonly userActivityRepository: UserActivityRepository,
    private readonly outOfBandVerification: OutOfBandVerification,
    // TODO: Remove duplicate, unused variable
    private readonly userActivityService: UserActivityService,
    private readonly emailData: EmailDto,
    // TODO: Remove duplicate, unused variable
    @Inject(CACHE_MANAGER) private readonly cacheService: Cache,
    private readonly natsClient: NATSClient,
    private readonly emailService: EmailService,
    private readonly proofResponseCodeService: ProofResponseCodeService
  ) {}

  /**
   * Get all proof presentations
   * @param user
   * @param orgId
   * @returns Get all proof presentation
   */

  async getProofPresentations(
    user: IUserRequest,
    orgId: string,
    proofRequestsSearchCriteria: IProofRequestSearchCriteria
  ): Promise<IProofPresentationList> {
    try {
      const getProofRequestsList = await this.verificationRepository.getAllProofRequests(
        user,
        orgId,
        proofRequestsSearchCriteria
      );
      const schemaIds = getProofRequestsList?.proofRequestsList?.map((schema) => schema?.schemaId).filter(Boolean);

      const getSchemaDetails = await this._getSchemaAndOrganizationDetails(schemaIds);

      const proofDetails = getProofRequestsList.proofRequestsList.map((proofRequest) => {
        const schemaDetail = getSchemaDetails.find((schema) => schema.schemaLedgerId === proofRequest.schemaId);

        return {
          ...proofRequest,
          schemaName: schemaDetail ? schemaDetail?.name : '',
          issuanceEntity: schemaDetail ? schemaDetail?.['organisation']?.name : ''
        };
      });

      if (0 === getProofRequestsList.proofRequestsCount) {
        throw new NotFoundException(ResponseMessages.verification.error.proofPresentationNotFound);
      }

      const proofPresentationsResponse: {
        totalItems: number;
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        nextPage: number;
        previousPage: number;
        lastPage: number;
        data: {
          createDateTime: Date;
          createdBy: string;
          connectionId: string;
          state: string;
          orgId: string;
          presentationId: string;
          id: string;
        }[];
      } = {
        totalItems: getProofRequestsList.proofRequestsCount,
        hasNextPage:
          proofRequestsSearchCriteria.pageSize * proofRequestsSearchCriteria.pageNumber <
          getProofRequestsList.proofRequestsCount,
        hasPreviousPage: 1 < proofRequestsSearchCriteria.pageNumber,
        nextPage: Number(proofRequestsSearchCriteria.pageNumber) + 1,
        previousPage: proofRequestsSearchCriteria.pageNumber - 1,
        lastPage: Math.ceil(getProofRequestsList.proofRequestsCount / proofRequestsSearchCriteria.pageSize),
        data: proofDetails || getProofRequestsList?.proofRequestsList
      };

      return proofPresentationsResponse;
    } catch (error) {
      this.logger.error(
        `[getProofRequests] [NATS call]- error in fetch proof requests details : ${JSON.stringify(error)}`
      );
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _getSchemaAndOrganizationDetails(templateIds: string[]): Promise<ISchemaDetail[]> {
    const pattern = { cmd: 'get-schemas-details' };

    const payload = {
      templateIds
    };
    const schemaAndOrgDetails = await this.natsClient
      .send<ISchemaDetail[]>(this.verificationServiceProxy, pattern, payload)

      .catch((error) => {
        this.logger.error(`catch: ${JSON.stringify(error)}`);
        throw new HttpException(
          {
            status: error.status,
            error: error.message
          },
          error.status
        );
      });
    return schemaAndOrgDetails;
  }

  async getVerificationRecords(orgId: string): Promise<number> {
    try {
      return await this.verificationRepository.getVerificationRecordsCount(orgId);
    } catch (error) {
      this.logger.error(
        `[getVerificationRecords ] [NATS call]- error in get verification records count : ${JSON.stringify(error)}`
      );
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Get verified proof presentation by issuerId
   * @param issuerId
   * @returns Proof presentation details by issuerId
   */
  async getProofPresentationByIssuerId(issuerId: string): Promise<number> {
    try {
      const orgDetails = await this.verificationRepository.getOrgDetails(issuerId);

      const getVerifiedProofCount = await this.verificationRepository.getVerificationRecordsCount(
        orgDetails?.['orgId'],
        VerificationProcessState.DONE
      );

      return getVerifiedProofCount;
    } catch (error) {
      this.logger.error(
        `[getProofPresentationByIssuerId] - error in get proof presentation by issuerId : ${JSON.stringify(error)}`
      );
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Get proof presentation by proofId
   * @param proofId
   * @param orgId
   * @returns Proof presentation details by proofId
   */
  async getProofPresentationById(proofId: string, orgId: string): Promise<object> {
    try {
      const getAgentDetails = await this.verificationRepository.getAgentEndPoint(orgId);
      const url = getAgentUrl(
        getAgentDetails?.agentEndPoint,
        CommonConstants.URL_GET_PROOF_PRESENTATION_BY_ID_FLAG,
        proofId
      );

      const payload = { orgId, url };

      const getProofPresentationById = await this._getProofPresentationById(payload);
      return getProofPresentationById;
    } catch (error) {
      this.logger.error(
        `[getProofPresentationById] - error in get proof presentation by proofId : ${JSON.stringify(error)}`
      );
      const errorMessage = error?.error?.reason || error?.message;

      if (errorMessage?.includes('not found')) {
        throw new NotFoundException(errorMessage);
      }

      throw new RpcException(error);
    }
  }

  /**
   * Consume agent API for get proof presentation by id
   * @param payload
   * @returns Get proof presentation details
   */
  async _getProofPresentationById(payload: IGetProofPresentationById): Promise<object> {
    try {
      const pattern = {
        cmd: 'agent-get-proof-presentation-by-id'
      };

      const result = await this.natsClient.send<object>(this.verificationServiceProxy, pattern, payload);
      return result;
    } catch (error) {
      this.logger.error(
        `[_getProofPresentationById] - error in get proof presentation by id : ${JSON.stringify(error)}`
      );
      throw error;
    }
  }

  /**
   * Send proof request
   * @param orgId
   * @returns Requested proof presentation details
   */

  async sendProofRequest(requestProof: IProofRequestData): Promise<object | object[]> {
    try {
      const comment = requestProof.comment ? requestProof.comment : '';
      const getAgentDetails = await this.verificationRepository.getAgentEndPoint(requestProof.orgId);
      const url = getAgentUrl(getAgentDetails?.agentEndPoint, CommonConstants.REQUEST_PROOF);
      // Function to create a payload
      const createPayload = async (connectionId: string): Promise<IProofRequestPayload> => {
        const proofRequestPayload = {
          comment,
          connectionId,
          autoAcceptProof: requestProof.autoAcceptProof || AutoAccept.Never,
          goalCode: requestProof.goalCode || undefined,
          parentThreadId: requestProof.parentThreadId || undefined,
          willConfirm: requestProof.willConfirm || undefined,
          expiresInSeconds: toAgentExpiresInSeconds(requestProof.expiresInSeconds)
        };

        const payload: IProofRequestPayload = {
          orgId: requestProof.orgId,
          url,
          proofRequestPayload: {}
        };

        if (requestProof.type === ProofRequestType.INDY) {
          const { requestedAttributes, requestedPredicates } = await this._proofRequestPayload(
            requestProof as IRequestProof
          );
          payload.proofRequestPayload = {
            protocolVersion: requestProof.protocolVersion || ProtocolVersionType.PROTOCOL_VERSION_1,
            proofFormats: {
              indy: {
                name: ProofRequestLabel.PROOF_REQUEST,
                version: ProofVersion.PROOF_VERSION,
                requested_attributes: requestedAttributes,
                requested_predicates: requestedPredicates
              }
            },
            ...proofRequestPayload
          };
        } else if (requestProof.type === ProofRequestType.PRESENTATIONEXCHANGE) {
          payload.proofRequestPayload = {
            protocolVersion: requestProof.protocolVersion || ProtocolVersionType.PROTOCOL_VERSION_2,
            proofFormats: {
              presentationExchange: {
                presentationDefinition: requestProof.presentationDefinition
              }
            },
            ...proofRequestPayload
          };
        }

        return payload;
      };

      if (API_Version.VERSION_1 === requestProof.version) {
        const connectionIds = Array.isArray(requestProof.connectionId)
          ? requestProof.connectionId
          : [requestProof.connectionId];

        const responses: object[] = [];
        for (const connectionId of connectionIds) {
          const payload = await createPayload(connectionId);
          const getProofPresentationById = await this._sendProofRequest(payload);
          responses.push(getProofPresentationById);
        }
        return responses;
      } else {
        const connectionId = Array.isArray(requestProof.connectionId)
          ? requestProof.connectionId[0]
          : requestProof.connectionId;

        const payload = await createPayload(connectionId);
        const getProofPresentationById = await this._sendProofRequest(payload);
        return getProofPresentationById;
      }
    } catch (error) {
      // Handle cases where identical attributes are used in both predicates and non-predicates.
      // This case is not supported in credo-ts, so we are handling in platform
      // TODO: Handle all credo-errors globally in platform

      const errorMessage = error?.status?.message?.error?.message;
      const match = errorMessage?.match(
        /CredoError: The proof request contains duplicate predicates and attributes: (.+)/
      );
      if (match) {
        const [, duplicateAttributes] = match;
        throw new RpcException({
          message: `CredoError: The proof request contains duplicate attributes: ${duplicateAttributes}`,
          statusCode: 500
        });
      }

      this.logger.error(`[sendProofRequest] - error in sending proof request: ${JSON.stringify(error)}`);
      this.verificationErrorHandling(error);
    }
  }

  /**
   * Consume agent API for request proof presentation
   * @param orgId
   * @returns Get requested proof presentation details
   */
  async _sendProofRequest(payload: IProofRequestPayload): Promise<object> {
    try {
      const pattern = {
        cmd: 'agent-send-proof-request'
      };

      const result = await this.natsClient.send<object>(this.verificationServiceProxy, pattern, payload);
      return result;
    } catch (error) {
      this.logger.error(`[_sendProofRequest] - nats error in sending proof request : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   * Verify proof presentation
   * @param proofId
   * @param orgId
   * @returns Verified proof presentation details
   */
  async verifyPresentation(proofId: string, orgId: string): Promise<object> {
    try {
      const getAgentData = await this.verificationRepository.getAgentEndPoint(orgId);
      const url = getAgentUrl(getAgentData?.agentEndPoint, CommonConstants.ACCEPT_PRESENTATION, proofId);

      const payload = { orgId, url };
      const getProofPresentationById = await this._verifyPresentation(payload);
      return getProofPresentationById;
    } catch (error) {
      this.logger.error(
        `[getProofPresentationById] - error in get proof presentation by proofId : ${JSON.stringify(error)}`
      );
      const errorStack = error?.error?.reason;

      if (errorStack) {
        throw new RpcException({
          message: ResponseMessages.verification.error.proofNotFound,
          statusCode: error?.status,
          error: errorStack
        });
      } else {
        throw new RpcException(error || 'Something went wrong');
      }
    }
  }

  /**
   * Consume agent API for verify proof presentation
   * @param payload
   * @returns Get verified proof presentation details
   */
  async _verifyPresentation(payload: IVerifyPresentation): Promise<object> {
    try {
      const pattern = {
        cmd: 'agent-verify-presentation'
      };

      const result = await this.natsClient.send<object>(this.verificationServiceProxy, pattern, payload);
      return result;
    } catch (error) {
      this.logger.error(`[_verifyPresentation] - error in verify presentation : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async webhookProofPresentation(proofPresentationPayload: IProofPresentation): Promise<presentations> {
    try {
      const proofPresentation = await this.verificationRepository.storeProofPresentation(proofPresentationPayload);
      await this.updateResponseCodeSession(proofPresentationPayload);
      return proofPresentation;
    } catch (error) {
      this.logger.error(`[webhookProofPresentation] - error in webhook proof presentation : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Request out-of-band proof presentation
   * @param outOfBandRequestProof
   * @returns Get requested proof presentation details
   */
  async sendOutOfBandPresentationRequest(
    outOfBandRequestProof: ISendProofRequestPayload,
    user: IUserRequest
  ): Promise<boolean | object> {
    try {
      // const { requestedAttributes, requestedPredicates } = await this._proofRequestPayload(outOfBandRequestProof);

      const [getAgentDetails, getOrganization] = await Promise.all([
        this.verificationRepository.getAgentEndPoint(user.orgId),
        this.verificationRepository.getOrganization(user.orgId)
      ]);

      if (outOfBandRequestProof.redirectUri) {
        if (outOfBandRequestProof.emailId) {
          throw new BadRequestException(ResponseMessages.verification.error.redirectUriWithEmail);
        }
        const allowlist = parseRedirectUriAllowlist(getAgentDetails?.redirectUriAllowlist);
        if (!isRedirectUriAllowed(outOfBandRequestProof.redirectUri, allowlist, isHttpRedirectUriAllowed())) {
          throw new BadRequestException(ResponseMessages.verification.error.redirectUriNotAllowed);
        }
      }

      const label = getOrganization?.name;

      if (getOrganization?.logoUrl) {
        outOfBandRequestProof['imageUrl'] = getOrganization?.logoUrl;
      }

      outOfBandRequestProof['label'] = label;

      const url = getAgentUrl(getAgentDetails?.agentEndPoint, CommonConstants.CREATE_OUT_OF_BAND_PROOF_PRESENTATION);

      // Destructuring 'outOfBandRequestProof' to remove emailId, as it is not used while agent operation
      const {
        isShortenUrl,
        emailId,
        type,
        reuseConnection,
        redirectUri,
        expiresInSeconds: requestedExpiresInSeconds,
        ...updateOutOfBandRequestProof
      } = outOfBandRequestProof;
      let reuseDids: ReuseInvitationDids = {};
      if (true === reuseConnection) {
        reuseDids = await this.verificationRepository.getReuseInvitationDids(user.orgId);
      }
      const { invitationDid } = reuseDids;
      outOfBandRequestProof.autoAcceptProof = outOfBandRequestProof.autoAcceptProof || AutoAccept.Always;
      const expiresInSeconds =
        toAgentExpiresInSeconds(requestedExpiresInSeconds) ??
        (redirectUri ? redirectDefaultExpiresInSeconds() : undefined);

      let payload: IProofRequestPayload;

      if (ProofRequestType.INDY === type) {
        updateOutOfBandRequestProof.protocolVersion = updateOutOfBandRequestProof.protocolVersion || 'v1';
        updateOutOfBandRequestProof.invitationDid = invitationDid || undefined;
        Object.assign(updateOutOfBandRequestProof, additionalInvitationDidsField(reuseDids));
        updateOutOfBandRequestProof.imageUrl = getOrganization?.logoUrl || undefined;
        payload = {
          orgId: user.orgId,
          url,
          proofRequestPayload: { ...updateOutOfBandRequestProof, expiresInSeconds }
        };
      }

      if (ProofRequestType.PRESENTATIONEXCHANGE === type) {
        payload = {
          orgId: user.orgId,
          url,
          proofRequestPayload: {
            goalCode: outOfBandRequestProof.goalCode,
            // TODO: [Credo-ts] Issue with parentThreadId in creating an OOB proof request.
            // This causes failures in OOB connection establishment.
            // parentThreadId: outOfBandRequestProof?.parentThreadId,
            protocolVersion: outOfBandRequestProof.protocolVersion || 'v2',
            comment: outOfBandRequestProof.comment,
            label,
            imageUrl: outOfBandRequestProof?.imageUrl,
            proofFormats: {
              presentationExchange: {
                presentationDefinition: {
                  id: outOfBandRequestProof.presentationDefinition.id,
                  name: outOfBandRequestProof.presentationDefinition.name,
                  purpose: outOfBandRequestProof?.presentationDefinition?.purpose,
                  input_descriptors: [...outOfBandRequestProof.presentationDefinition.input_descriptors]
                }
              }
            },
            autoAcceptProof: outOfBandRequestProof.autoAcceptProof,
            invitationDid: invitationDid || undefined,
            ...additionalInvitationDidsField(reuseDids),
            expiresInSeconds
          }
        };
      }
      if (emailId) {
        const emailResponse = await this.sendEmailInBatches(payload, emailId, getAgentDetails, getOrganization);
        await this.verificationRepository.saveEmail(emailResponse as IEmailResponse[]);
        return emailResponse;
      } else {
        // The agent counts the deadline from about now, so the hosted page never shows a later one (DL-017).
        const requestedAt = Date.now();
        const presentationProof: IInvitation = await this.generateOOBProofReq(payload);
        const proofRequestInvitationUrl: string = presentationProof.invitationUrl;
        if (isShortenUrl) {
          const shortenedUrl: string = await this.storeVerificationObjectAndReturnUrl(proofRequestInvitationUrl, false);
          this.logger.log('shortenedUrl', shortenedUrl);
          if (shortenedUrl) {
            presentationProof.invitationUrl = shortenedUrl;
            presentationProof.deepLinkURL = convertUrlToDeepLinkUrl(shortenedUrl);
          }
        }
        if (!presentationProof) {
          throw new Error(ResponseMessages.verification.error.proofPresentationNotFound);
        }
        if (!presentationProof.deepLinkURL && process.env.DEEPLINK_DOMAIN) {
          presentationProof.deepLinkURL = convertUrlToDeepLinkUrl(presentationProof.invitationUrl);
        }
        if (redirectUri) {
          await this.attachRedirect(presentationProof, user.orgId, redirectUri, expiresInSeconds, requestedAt);
        }
        return presentationProof;
      }
    } catch (error) {
      this.logger.error(`[sendOutOfBandPresentationRequest] - error in out of band proof request : ${error.message}`);
      if (error instanceof BadRequestException) {
        throw new RpcException(error.getResponse());
      }
      this.verificationErrorHandling(error);
    }
  }

  private async attachRedirect(
    presentationProof: IInvitation,
    orgId: string,
    redirectUri: string,
    expiresInSeconds?: number,
    requestedAt: number = Date.now()
  ): Promise<void> {
    const threadId = presentationProof.proofRecordThId;
    if (!threadId) {
      this.logger.warn(`[attachRedirect] - no proofRecordThId returned by the agent; skipping redirect`);
      return;
    }
    let responseCode: string;
    try {
      responseCode = await this.proofResponseCodeService.createSession(orgId, threadId, redirectUri, expiresInSeconds);
    } catch (error) {
      // The invitation already exists; return it without redirect rather than failing the request.
      this.logger.error(`[attachRedirect] - failed to create response_code session: ${error?.message}`);
      return;
    }
    presentationProof.returnUrl = buildReturnUrl(redirectUri, responseCode);
    if (presentationProof.deepLinkURL) {
      presentationProof.deepLinkURL = appendReturnUrl(presentationProof.deepLinkURL, presentationProof.returnUrl);
    }
    await this.attachHostedPage(presentationProof, orgId, threadId, redirectUri, expiresInSeconds, requestedAt);
  }

  /**
   * Creates the NDI hosted page's session beside the response_code session (HVP-SD §5.2, DL-017). It lives one grace
   * period longer, so the page can read `expired` after the code session ends. Like the redirect itself, a failure
   * leaves the invitation usable, only without hostedPageUrl.
   * deepLinkURL carries returnUrl (E7, DL-007), so the hostedId holder can use up the code's single terminal read.
   */
  private async attachHostedPage(
    presentationProof: IInvitation,
    orgId: string,
    threadId: string,
    redirectUri: string,
    expiresInSeconds: number | undefined,
    requestedAt: number
  ): Promise<void> {
    const baseUrl = hostedPageBaseUrl();
    if (!baseUrl) {
      return;
    }
    const ttlSeconds = this.proofResponseCodeService.sessionTtlSeconds(expiresInSeconds);
    const lifetimeMs = (expiresInSeconds ?? ttlSeconds) * 1000;
    try {
      const hostedId = await this.proofResponseCodeService.createHostedSession(
        {
          orgId,
          threadId,
          proofRequestURL: presentationProof.invitationUrl,
          deepLinkURL: presentationProof.deepLinkURL,
          returnUrl: presentationProof.returnUrl,
          redirectUri,
          returnHost: new URL(redirectUri).host,
          outOfBandId: presentationProof.outOfBandRecord?.id,
          expiresAt: new Date(requestedAt + lifetimeMs).toISOString()
        },
        ttlSeconds + REQUEST_DEADLINE_GRACE_SECONDS
      );
      presentationProof.hostedPageUrl = `${baseUrl}/v/${hostedId}`;
    } catch (error) {
      this.logger.error(`[attachHostedPage] - failed to create hosted session: ${error?.message}`);
    }
  }

  /** What the hosted page needs to show a request. Unknown and expired ids get the same not-found (HVP-SD §6). */
  async getHostedPage(hostedId: string): Promise<IHostedPage> {
    const session = await this.findHostedSession(hostedId);
    return {
      returnHost: session.returnHost,
      redirectUri: session.redirectUri,
      proofRequestURL: session.proofRequestURL,
      deepLinkURL: session.deepLinkURL,
      expiresAt: session.expiresAt
    };
  }

  /**
   * The hosted page's polled status (HVP-SD §5.3). Reads the response_code session without consuming it, so the relying
   * party can still exchange the code; callback-result cannot be used because a terminal read deletes the session.
   */
  async getHostedStatus(hostedId: string): Promise<IHostedStatus> {
    const session = await this.findHostedSession(hostedId);
    const reads = await this.callHostedStore(() => this.proofResponseCodeService.countHostedStatusRead(hostedId));
    if (reads > hostedStatusReadsPerMinute()) {
      throw new RpcException({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: ResponseMessages.verification.error.hostedStatusRateLimited,
        error: 'Too Many Requests'
      });
    }
    // Pending through the grace period: a result that lands then is still delivered, so `expired` is only reported
    // once nothing can change it.
    const graceMs = REQUEST_DEADLINE_GRACE_SECONDS * 1000;
    const pastDeadline = Date.now() >= Date.parse(session.expiresAt) + graceMs;
    const { threadId } = session;
    const codeSession = await this.callHostedStore(() => this.proofResponseCodeService.getSessionByThreadId(threadId));
    if (codeSession && ResponseCodeStatus.PENDING !== codeSession.status) {
      // Completed or failed: the page sends the browser back with the code. Expired: it offers "Start again" (DL-013).
      return ResponseCodeStatus.EXPIRED === codeSession.status
        ? { status: 'expired' }
        : { status: codeSession.status, returnUrl: session.returnUrl };
    }
    if (!codeSession && session.outcome) {
      // The code was already exchanged or its result window has passed: report the outcome, with nothing to return.
      return { status: session.outcome };
    }
    if (pastDeadline) {
      return { status: 'expired' };
    }
    // Optional: without the scan signal the page simply stays on pending (DL-016).
    const scanned = await this.callHostedStore(() => this.proofResponseCodeService.isHostedScanned(hostedId));
    return { status: scanned ? 'scanned' : 'pending' };
  }

  /**
   * The wallet connected for an invitation, which it does as soon as it scans and before it shows the request
   * (HVP-SD E10, DL-016). Sent by the connection service; never fails the connection webhook.
   */
  async markHostedScanned(outOfBandId: string, orgId: string): Promise<void> {
    if (!outOfBandId || !orgId) {
      return;
    }
    try {
      await this.proofResponseCodeService.markHostedScanned(outOfBandId, orgId);
    } catch (error) {
      this.logger.warn(`[markHostedScanned] - could not mark ${outOfBandId} scanned: ${error?.message}`);
    }
  }

  private async findHostedSession(hostedId: string): Promise<IHostedSession> {
    const session = hostedId
      ? await this.callHostedStore(() => this.proofResponseCodeService.getHostedSession(hostedId))
      : null;
    if (!session) {
      throw new RpcException(
        new NotFoundException(ResponseMessages.verification.error.hostedSessionNotFound).getResponse()
      );
    }
    return session;
  }

  /** A store outage is a 503, never a not-found: the session may be fine once Redis is back. */
  private async callHostedStore<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      this.logger.error(`[hosted] - session store unavailable: ${error?.message}`);
      throw new RpcException(
        new ServiceUnavailableException(ResponseMessages.verification.error.responseCodeUnavailable).getResponse()
      );
    }
  }

  private async updateResponseCodeSession({ proofPresentationPayload }: IProofPresentation): Promise<void> {
    const { threadId, state, isVerified, presentationId, errorMessage } = proofPresentationPayload ?? {};
    const status = toTerminalResponseCodeStatus(state, isVerified, errorMessage);
    if (!threadId || !status) {
      return;
    }
    try {
      await this.proofResponseCodeService.markTerminalByThreadId(threadId, status, {
        state,
        presentationId
      });
      await this.proofResponseCodeService.recordHostedOutcome(threadId, status);
    } catch (error) {
      this.logger.error(`[updateResponseCodeSession] - error for threadId ${threadId}: ${error?.message}`);
    }
  }

  async getProofCallbackResult(responseCode: string): Promise<IProofCallbackResult> {
    const expired: IProofCallbackResult = { status: ResponseCodeStatus.EXPIRED };
    if (!responseCode) {
      return expired;
    }
    try {
      const session = await this.proofResponseCodeService.getSession(responseCode);
      if (!session) {
        return expired;
      }
      if (ResponseCodeStatus.PENDING === session.status) {
        return { status: ResponseCodeStatus.PENDING };
      }
      const consumed = await this.proofResponseCodeService.consume(responseCode, session.threadId);
      if (!consumed) {
        return expired;
      }
      return { status: session.status, threadId: session.threadId, result: session.result };
    } catch (error) {
      // Not "expired": the code may still be valid once the store is reachable again.
      this.logger.error(`[getProofCallbackResult] - response_code store unavailable: ${error?.message}`);
      throw new RpcException(
        new ServiceUnavailableException(ResponseMessages.verification.error.responseCodeUnavailable).getResponse()
      );
    }
  }

  async setRedirectUris(orgId: string, redirectUris: string[], userId: string): Promise<string[]> {
    try {
      const normalized = [...new Set(redirectUris.map((uri) => uri.trim()))];
      const allowHttp = isHttpRedirectUriAllowed();
      if (!normalized.every((uri) => hasAllowedRedirectProtocol(uri, allowHttp))) {
        throw new BadRequestException(ResponseMessages.verification.error.redirectUriHttpsRequired);
      }
      await this.verificationRepository.getAgentEndPoint(orgId);
      const updated = await this.verificationRepository.updateRedirectUriAllowlist(orgId, normalized.join(','), userId);
      return parseRedirectUriAllowlist(updated.redirectUriAllowlist);
    } catch (error) {
      this.logger.error(`[setRedirectUris] - error: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getRedirectUris(orgId: string): Promise<string[]> {
    try {
      const orgAgent = await this.verificationRepository.getAgentEndPoint(orgId);
      return parseRedirectUriAllowlist(orgAgent.redirectUriAllowlist);
    } catch (error) {
      this.logger.error(`[getRedirectUris] - error: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async storeVerificationObjectAndReturnUrl(storeObj: string, persistent: boolean): Promise<string> {
    //nats call in agent-service to create an invitation url
    const pattern = { cmd: 'store-object-return-url' };
    const payload = { persistent, storeObj };
    const message = await this.natsClient.send<string>(this.verificationServiceProxy, pattern, payload);
    return message;
  }

  private async generateOOBProofReq(payload: IProofRequestPayload): Promise<unknown> {
    const getProofPresentation = await this._sendOutOfBandProofRequest(payload);

    if (!getProofPresentation) {
      throw new Error(ResponseMessages.verification.error.proofPresentationNotFound);
    }
    return getProofPresentation;
  }

  // Currently batch size is not used, as length of emails sent is restricted to '10'
  async sendEmailInBatches(
    payload: IProofRequestPayload,
    emailIds: string[],
    getAgentDetails: org_agents,
    organizationDetails: organisation
  ): Promise<object> {
    try {
      const accumulatedErrors = [];
      const accumulatedResponse = [];

      for (const email of emailIds) {
        try {
          const response = await this.sendOutOfBandProofRequest(payload, email, getAgentDetails, organizationDetails);
          accumulatedResponse.push({ email, ...response });

          await this.delay(500);
        } catch (error) {
          this.logger.error(`Error sending email to ${email}::::::`, error);
          accumulatedErrors.push(error);
        }
      }

      if (0 < accumulatedErrors.length) {
        this.logger.error(accumulatedErrors);
        throw new Error(ResponseMessages.verification.error.emailSend);
      }

      return accumulatedResponse;
    } catch (error) {
      this.logger.error('[sendEmailInBatches] - error in sending email in batches');
      throw new Error(ResponseMessages.verification.error.batchEmailSend);
    }
  }

  // This function is specifically for OOB verification using email
  async sendOutOfBandProofRequest(
    payload: IProofRequestPayload,
    email: string,
    getAgentDetails: org_agents,
    organizationDetails: organisation
  ): Promise<object> {
    const getProofPresentation: IInvitation = await this._sendOutOfBandProofRequest(payload);

    if (!getProofPresentation) {
      throw new Error(ResponseMessages.verification.error.proofPresentationNotFound);
    }

    const invitationUrl = getProofPresentation?.invitationUrl;
    // Currently have shortenedUrl to store only for 30 days
    const persist: boolean = false;
    const shortenedUrl = await this.storeVerificationObjectAndReturnUrl(invitationUrl, persist);
    const deepLinkURL = convertUrlToDeepLinkUrl(shortenedUrl);
    const qrCodeOptions: QRCode.QRCodeToDataURLOptions = { type: 'image/png' };
    const outOfBandVerificationQrCode = await QRCode.toDataURL(shortenedUrl, qrCodeOptions);

    const platformConfigData = await this.verificationRepository.getPlatformConfigDetails();

    if (!platformConfigData) {
      throw new Error(ResponseMessages.verification.error.platformConfigNotFound);
    }

    this.emailData.emailFrom = platformConfigData.emailFrom;
    this.emailData.emailTo = email;
    this.emailData.emailSubject = `${process.env.PLATFORM_NAME} Platform: Verification of Your Credentials`;
    this.emailData.emailHtml = await this.outOfBandVerification.outOfBandVerification(
      email,
      organizationDetails.name,
      deepLinkURL
    );
    this.emailData.emailAttachments = [
      {
        filename: 'qrcode.png',
        content: outOfBandVerificationQrCode.split(';base64,')[1],
        contentType: 'image/png',
        disposition: 'attachment'
      }
    ];
    const isEmailSent = await this.emailService.sendEmail(this.emailData);

    if (!isEmailSent) {
      throw new Error(ResponseMessages.verification.error.emailSend);
    }

    return {
      isEmailSent,
      outOfBandRecordId: getProofPresentation?.outOfBandRecord?.id,
      proofRecordThId: getProofPresentation?.proofRecordThId
    };
  }

  /**
   * Consume agent API for request out-of-band proof presentation
   * @param payload
   * @returns Get requested proof presentation details
   */
  async _sendOutOfBandProofRequest(payload: IProofRequestPayload): Promise<unknown> {
    try {
      const pattern = {
        cmd: 'agent-send-out-of-band-proof-request'
      };

      const result = await this.natsClient.send(this.verificationServiceProxy, pattern, payload);
      return result;
    } catch (error) {
      this.logger.error(`[_sendOutOfBandProofRequest] - error in Out Of Band Presentation : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async _proofRequestPayload(proofRequestpayload: IProofRequestData): Promise<{
    requestedAttributes;
    requestedPredicates;
  }> {
    try {
      let requestedAttributes = {};
      const requestedPredicates = {};

      const indyAttributes = proofRequestpayload.proofFormats?.indy;
      if (indyAttributes && indyAttributes.attributes) {
        requestedAttributes = Object.fromEntries(
          indyAttributes.attributes.map((attribute, index) => {
            const attributeElement = attribute.attributeName || attribute.attributeNames;
            const attributeReferent = `additionalProp${index + 1}`;
            const attributeKey = attribute.attributeName ? 'name' : 'names';

            if (!attribute.condition && !attribute.value) {
              return [
                attributeReferent,
                {
                  [attributeKey]: attributeElement,
                  restrictions: [
                    {
                      cred_def_id: proofRequestpayload?.proofFormats?.indy?.attributes[index].credDefId
                        ? proofRequestpayload.proofFormats.indy.attributes[index].credDefId
                        : undefined,
                      schema_id: proofRequestpayload?.proofFormats?.indy?.attributes[index].schemaId
                    }
                  ]
                }
              ];
            } else {
              requestedPredicates[attributeReferent] = {
                p_type: attribute.condition,
                name: attributeElement,
                p_value: parseInt(attribute.value),
                restrictions: [
                  {
                    cred_def_id: proofRequestpayload?.proofFormats?.indy?.attributes[index].credDefId
                      ? proofRequestpayload?.proofFormats?.indy?.attributes[index].credDefId
                      : undefined,
                    schema_id: proofRequestpayload?.proofFormats?.indy?.attributes[index].schemaId
                  }
                ]
              };
            }

            return [attributeReferent];
          })
        );

        return {
          requestedAttributes,
          requestedPredicates
        };
      } else {
        throw new BadRequestException(ResponseMessages.verification.error.proofNotSend);
      }
    } catch (error) {
      this.logger.error(`[proofRequestPayload] - error in proof request payload : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getVerifiedProofdetails(proofId: string, orgId: string): Promise<IProofPresentationDetails[]> {
    try {
      const getAgentDetails = await this.verificationRepository.getAgentEndPoint(orgId);
      let credDefId;
      let schemaId;
      let certificate;
      const url = getAgentUrl(getAgentDetails?.agentEndPoint, CommonConstants.GET_VERIFIED_PROOF, proofId);

      const payload = { orgId, url };

      const getProofPresentationById = await this._getVerifiedProofDetails(payload);

      if (!getProofPresentationById?.presentation) {
        throw new NotFoundException(ResponseMessages.verification.error.proofPresentationNotFound, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.notFound
        });
      }

      const extractedDataArray: IProofPresentationDetails[] = [];

      // For Presentation Exchange format
      if (getProofPresentationById?.request?.presentationExchange) {
        const presentationDefinition = getProofPresentationById?.request?.presentationExchange?.presentation_definition;
        const verifiableCredentials =
          getProofPresentationById?.presentation?.presentationExchange?.verifiableCredential;

        presentationDefinition?.input_descriptors.forEach((descriptor, index) => {
          const schemaId = descriptor?.schema[0]?.uri;
          const requestedAttributesForPresentationExchangeFormat = descriptor?.constraints?.fields[0]?.path;

          const verifiableCredential = verifiableCredentials[index]?.credentialSubject;
          certificate =
            getProofPresentationById?.presentation?.presentationExchange?.verifiableCredential[0].prettyVc?.certificate;

          if (
            requestedAttributesForPresentationExchangeFormat &&
            Array.isArray(requestedAttributesForPresentationExchangeFormat)
          ) {
            requestedAttributesForPresentationExchangeFormat.forEach((requestedAttributeKey) => {
              const attributeName =
                requestedAttributeKey?.match(ATTRIBUTE_NAME_REGEX)?.[1] || requestedAttributeKey?.split('.').pop();
              const attributeValue = verifiableCredential?.[attributeName];

              if (attributeName && attributeValue !== undefined) {
                const extractedData: IProofPresentationDetails = {
                  [attributeName]: attributeValue,
                  schemaId: schemaId || null,
                  certificateTemplate: certificate
                };

                extractedDataArray.push(extractedData);
              }
            });
          }
        });
      }
      // For Indy format
      if (getProofPresentationById?.request?.indy) {
        const requestedAttributes = getProofPresentationById?.request?.indy?.requested_attributes;
        const requestedPredicates = getProofPresentationById?.request?.indy?.requested_predicates;
        const revealedAttrs = getProofPresentationById?.presentation?.indy?.requested_proof?.revealed_attrs;

        if (0 !== Object.keys(requestedAttributes).length && 0 !== Object.keys(requestedPredicates).length) {
          for (const key in requestedAttributes) {
            if (requestedAttributes.hasOwnProperty(key)) {
              const requestedAttributeKey = requestedAttributes[key];
              const attributeName = requestedAttributeKey.name;

              if (requestedAttributeKey?.restrictions) {
                credDefId = requestedAttributeKey?.restrictions[0]?.cred_def_id;
                schemaId = requestedAttributeKey?.restrictions[0]?.schema_id;
              } else if (getProofPresentationById?.presentation?.indy?.identifiers) {
                credDefId = getProofPresentationById?.presentation?.indy?.identifiers[0].cred_def_id;
                schemaId = getProofPresentationById?.presentation?.indy?.identifiers[0].schema_id;
              }

              if (revealedAttrs.hasOwnProperty(key)) {
                const extractedData: IProofPresentationDetails = {
                  [attributeName]: revealedAttrs[key]?.raw,
                  credDefId: credDefId || null,
                  schemaId: schemaId || null
                };
                extractedDataArray.push(extractedData);
              }
            }
          }

          for (const key in requestedPredicates) {
            if (requestedPredicates.hasOwnProperty(key)) {
              const attribute = requestedPredicates[key];

              const attributeName = attribute?.name;

              if (attribute?.restrictions) {
                credDefId = attribute?.restrictions[0]?.cred_def_id;
                schemaId = attribute?.restrictions[0]?.schema_id;
              }

              const extractedData: IProofPresentationDetails = {
                [attributeName]: `${attribute?.p_type}${attribute?.p_value}`,
                credDefId: credDefId || null,
                schemaId: schemaId || null
              };
              extractedDataArray.push(extractedData);
            }
          }
        } else if (0 !== Object.keys(requestedAttributes).length) {
          for (const key in requestedAttributes) {
            if (requestedAttributes.hasOwnProperty(key)) {
              const attribute = requestedAttributes[key];
              const attributeName = attribute.name;

              [credDefId, schemaId] = await this._schemaCredDefRestriction(attribute, getProofPresentationById);

              if (revealedAttrs.hasOwnProperty(key)) {
                const extractedData: IProofPresentationDetails = {
                  [attributeName]: revealedAttrs[key]?.raw,
                  credDefId: credDefId || null,
                  schemaId: schemaId || null
                };
                extractedDataArray.push(extractedData);
              }
            }
          }
        } else if (0 !== Object.keys(requestedPredicates).length) {
          for (const key in requestedPredicates) {
            if (requestedPredicates.hasOwnProperty(key)) {
              const attribute = requestedPredicates[key];
              const attributeName = attribute?.name;

              [credDefId, schemaId] = await this._schemaCredDefRestriction(attribute, getProofPresentationById);
              const extractedData: IProofPresentationDetails = {
                [attributeName]: `${attribute?.p_type}${attribute?.p_value}`,
                credDefId: credDefId || null,
                schemaId: schemaId || null
              };
              extractedDataArray.push(extractedData);
            }
          }
        } else {
          throw new InternalServerErrorException(ResponseMessages.errorMessages.serverError, {
            cause: new Error(),
            description: ResponseMessages.errorMessages.serverError
          });
        }
      }

      return extractedDataArray;
    } catch (error) {
      this.logger.error(`[getVerifiedProofDetails] - error in get verified proof details : ${JSON.stringify(error)}`);
      const errorStack = error?.error?.reason;

      if (errorStack) {
        throw new RpcException({
          message: ResponseMessages.verification.error.verifiedProofNotFound,
          statusCode: error?.status,
          error: errorStack
        });
      } else {
        throw new RpcException(error);
      }
    }
  }

  /** Serves only verified proofs of this org; the data is read live from the agent, never cached. */
  async getProofPresentationByThreadId(orgId: string, threadId: string): Promise<IProofPresentationByThread> {
    try {
      const presentation = await this.verificationRepository.getPresentationByThreadId(threadId);
      if (!presentation || presentation.orgId !== orgId) {
        throw new NotFoundException(ResponseMessages.verification.error.verifiedProofNotFound);
      }
      if (VerificationProcessState.DONE !== presentation.state || true !== presentation.isVerified) {
        throw new ConflictException(ResponseMessages.verification.error.proofNotVerified);
      }
      if (!presentation.presentationId) {
        throw new ConflictException(ResponseMessages.verification.error.proofRecordNotLinked);
      }
      const agentDetails = await this.verificationRepository.getAgentEndPoint(orgId);
      const url = getAgentUrl(
        agentDetails?.agentEndPoint,
        CommonConstants.GET_VERIFIED_PROOF,
        presentation.presentationId
      );
      const proofData = await this._getVerifiedProofDetails({ orgId, url });
      // Same guard as getVerifiedProofdetails: the agent may answer 200 without the record (e.g. purged).
      if (!proofData?.presentation) {
        throw new NotFoundException(ResponseMessages.verification.error.verifiedProofNotFound);
      }
      return {
        threadId,
        presentationId: presentation.presentationId,
        connectionId: presentation.connectionId ?? undefined,
        state: presentation.state,
        isVerified: true,
        proofData
      };
    } catch (error) {
      this.logger.error(`[getProofPresentationByThreadId] - error: ${error?.message ?? JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _schemaCredDefRestriction(attribute, getProofPresentationById): Promise<string[]> {
    let credDefId;
    let schemaId;

    if (attribute?.restrictions) {
      credDefId = attribute?.restrictions[0]?.cred_def_id;
      schemaId = attribute?.restrictions[0]?.schema_id;
    } else if (getProofPresentationById?.presentation?.indy?.identifiers) {
      credDefId = getProofPresentationById?.presentation?.indy?.identifiers[0].cred_def_id;
      schemaId = getProofPresentationById?.presentation?.indy?.identifiers[0].schema_id;
    }

    return [credDefId, schemaId];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _getVerifiedProofDetails(payload: IVerifiedProofData): Promise<any> {
    try {
      //nats call in agent for fetch verified proof details
      const pattern = {
        cmd: 'get-agent-verified-proof-details'
      };

      const result = await this.natsClient.send(this.verificationServiceProxy, pattern, payload);
      return result;
    } catch (error) {
      this.logger.error(`[_getVerifiedProofDetails] - error in verified proof details : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async _getOrgAgentApiKey(orgId: string): Promise<string> {
    const pattern = { cmd: 'get-org-agent-api-key' };
    const payload = { orgId };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.natsClient.send<any>(this.verificationServiceProxy, pattern, payload);
      return message;
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      const status = resolveHttpStatus(error?.status, error?.code);
      throw new HttpException(
        {
          status,
          error: error.message
        },
        status
      );
    }
  }

  verificationErrorHandling(error): void {
    if (!error?.status?.message) {
      throw new RpcException(error?.response ? error.response : error);
    } else {
      throw new RpcException({
        message: error?.status?.message?.error?.reason
          ? error?.status?.message?.error?.reason
          : error?.status?.message?.error,
        statusCode: error?.status?.code
      });
    }
  }

  async delay(ms: number): Promise<unknown> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async deleteVerificationRecords(orgId: string, userDetails: user): Promise<IVerificationRecords> {
    try {
      const deleteProofRecords = await this.verificationRepository.deleteVerificationRecordsByOrgId(orgId);

      if (0 === deleteProofRecords?.deleteResult?.count) {
        throw new NotFoundException(ResponseMessages.verification.error.verificationRecordsNotFound);
      }

      const statusCounts = {
        [VerificationProcessState.PROPOSAL_SENT]: 0,
        [VerificationProcessState.PROPOSAL_RECEIVED]: 0,
        [VerificationProcessState.REQUEST_SENT]: 0,
        [VerificationProcessState.REQUEST_RECEIVED]: 0,
        [VerificationProcessState.PRESENTATION_RECEIVED]: 0,
        [VerificationProcessState.PRESENTATION_SENT]: 0,
        [VerificationProcessState.DONE]: 0,
        [VerificationProcessState.DECLINED]: 0,
        [VerificationProcessState.ABANDONED]: 0
      };

      await Promise.all(
        deleteProofRecords.recordsToDelete.map(async (record) => {
          statusCounts[record.state]++;
        })
      );

      const filteredStatusCounts = Object.fromEntries(Object.entries(statusCounts).filter((entry) => 0 < entry[1]));

      const deletedVerificationData = {
        deletedProofRecordsCount: deleteProofRecords?.deleteResult?.count,
        deletedRecordsStatusCount: filteredStatusCounts
      };

      await this.userActivityRepository._orgDeletedActivity(
        orgId,
        userDetails,
        deletedVerificationData,
        RecordType.VERIFICATION_RECORD
      );

      return deleteProofRecords;
    } catch (error) {
      this.logger.error(
        `[deleteVerificationRecords] - error in deleting verification records: ${JSON.stringify(error)}`
      );
      throw new RpcException(error.response ? error.response : error);
    }
  }
}
