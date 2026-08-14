/* eslint-disable camelcase */
import { CommonService } from '@credebl/common';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from '@nestjs/common';
import {
  IAcceptOffer,
  ICreateCloudWalletDid,
  IReceiveInvitation,
  IAcceptProofRequest,
  IProofRequestRes,
  ICloudBaseWalletConfigure,
  ICloudWalletDetails,
  ICreateCloudWallet,
  IGetProofPresentation,
  IGetProofPresentationById,
  IGetStoredWalletInfo,
  IStoredWalletDetails,
  CloudWallet,
  IStoreWalletInfo,
  IWalletDetailsForDidList,
  IConnectionDetailsById,
  ITenantDetail,
  ICredentialDetails,
  ICreateConnection,
  IConnectionInvitationResponse,
  GetAllCloudWalletConnections,
  IBasicMessage,
  IBasicMessageDetails,
  ICheckCloudWalletStatus,
  IDeleteCloudWallet,
  BaseAgentInfo,
  IUpdateBaseWallet,
  IW3cCredentials,
  IProofPresentationDetails,
  IExportCloudWallet,
  IImportCloudWallet,
  IWalletPortabilityJobStatus
} from '@credebl/common/interfaces/cloud-wallet.interface';
import { CloudWalletRepository } from './cloud-wallet.repository';
import { ResponseMessages } from '@credebl/common/response-messages';
import { CloudWalletType } from '@credebl/enum/enum';
import { CommonConstants } from '@credebl/common/common.constant';
// eslint-disable-next-line camelcase
import { cloud_wallet_user_info, user } from '@prisma/client';

@Injectable()
export class CloudWalletService {
  constructor(
    private readonly commonService: CommonService,
    private readonly cloudWalletRepository: CloudWalletRepository,
    private readonly logger: Logger
  ) {}

  /**
   * configure cloud base wallet
   * @param configureBaseWalletPayload
   * @returns cloud base wallet
   */
  async configureBaseWallet(configureBaseWalletPayload: ICloudBaseWalletConfigure): Promise<IGetStoredWalletInfo> {
    const { agentEndpoint, apiKey, email, walletKey, userId, maxSubWallets } = configureBaseWalletPayload;

    try {
      // Keyed on agentEndpoint, not (email, type)/(userId, type): agentEndpoint is the only thing
      // that actually identifies "the same base wallet" -- a duplicate-registration guard keyed on
      // the *caller's* identity instead would (a) throw for username-based admin accounts, whose
      // email is null, and (b) cap a deployment at one base wallet per admin, contradicting this
      // PR's own capacity-pool design (see the #71 review's two findings on this guard). This
      // reuses getBaseWalletByAgentEndpoint rather than a dedicated lookup -- same query either way.
      const existingWalletInfo = await this.cloudWalletRepository.getBaseWalletByAgentEndpoint(agentEndpoint);
      if (existingWalletInfo) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.agentAlreadyExist);
      }

      const [encryptionWalletKey, encryptionApiKey] = await Promise.all([
        this.commonService.dataEncryption(walletKey),
        this.commonService.dataEncryption(apiKey)
      ]);

      const walletInfoToStore: IStoreWalletInfo = {
        agentEndpoint,
        agentApiKey: encryptionApiKey,
        email,
        type: CloudWalletType.BASE_WALLET,
        userId,
        key: encryptionWalletKey,
        createdBy: userId,
        lastChangedBy: userId,
        maxSubWallets
      };

      const storedWalletInfo = await this.cloudWalletRepository.storeCloudWalletInfo(walletInfoToStore);
      return storedWalletInfo;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Create connection
   * @param createConnection
   * @returns connection details
   */
  async createConnection(createConnection: ICreateConnection): Promise<IConnectionInvitationResponse> {
    try {
      const { userId, ...connectionPayload } = createConnection;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);

      delete connectionPayload.email;
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.URL_CONN_INVITE}`;

      const createConnectionDetails = await this.commonService.httpPost(url, connectionPayload, {
        headers: { authorization: decryptedApiKey }
      });
      return createConnectionDetails;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Accept proof request
   * @param acceptProofRequest
   * @returns proof presentation
   */
  async acceptProofRequest(acceptProofRequest: IAcceptProofRequest): Promise<IProofRequestRes> {
    const { proofRecordId, comment, filterByNonRevocationRequirements, filterByPresentationPreview, userId } =
      acceptProofRequest;
    try {
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/${proofRecordId}${CommonConstants.CLOUD_WALLET_ACCEPT_PROOF_REQUEST}`;
      const proofAcceptRequestPayload = {
        comment,
        filterByNonRevocationRequirements,
        filterByPresentationPreview
      };

      const acceptProofRequest = await this.commonService.httpPost(url, proofAcceptRequestPayload, {
        headers: { authorization: decryptedApiKey }
      });
      return acceptProofRequest;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get proof presentation by proof Id
   * @param proofPrsentationByIdPayload
   * @returns proof presentation
   */
  async getProofById(proofPrsentationByIdPayload: IGetProofPresentationById): Promise<IProofRequestRes> {
    try {
      const { proofRecordId, userId } = proofPrsentationByIdPayload;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;
      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/${proofRecordId}}`;

      const getProofById = await this.commonService.httpGet(url, { headers: { authorization: decryptedApiKey } });
      return getProofById;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get proof presentation
   * @param proofPresentationPayload
   * @returns proof presentations
   */
  async getProofPresentation(proofPresentationPayload: IGetProofPresentation): Promise<IProofRequestRes[]> {
    try {
      const { threadId, userId } = proofPresentationPayload;

      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;
      const threadParam = threadId ? `?threadId=${threadId}` : '';
      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/${threadParam}}`;
      const getProofById = await this.commonService.httpGet(url, { headers: { authorization: decryptedApiKey } });
      return getProofById;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * common function for get cloud wallet
   * @param userId
   * @returns cloud wallet info
   */
  async _commonCloudWalletInfo(userId: string): Promise<[CloudWallet, string]> {
    const getTenant = await this.cloudWalletRepository.getCloudSubWallet(userId);

    if (!getTenant || !getTenant?.tenantId) {
      throw new NotFoundException(ResponseMessages.cloudWallet.error.walletRecordNotFound);
    }

    // Resolved by the tenant's OWN agentEndpoint, not an arbitrary active BASE_WALLET row.
    // getCloudWalletDetails's plain findFirstOrThrow picks whichever base wallet Postgres returns
    // first -- once more than one base wallet exists (this PR's own configureBaseWallet/
    // getAllBaseWallets/PATCH base-wallet/:walletId make that a real, supported topology), that
    // can be a different agent than the one this tenant actually lives on: the request would go
    // out to the wrong endpoint carrying a token that agent doesn't recognize. See the #71 review.
    const baseWalletDetails = await this.cloudWalletRepository.getBaseWalletByAgentEndpoint(getTenant.agentEndpoint);

    if (!baseWalletDetails) {
      throw new NotFoundException(ResponseMessages.cloudWallet.error.notFoundBaseWallet);
    }

    const decryptedApiKey = await this.commonService.decryptPassword(getTenant?.agentApiKey);

    // Authenticated — agent-controller's GET /agent now requires a JWT (AgentController.getAgentInfo
    // carries @Security since the #75 port), so an unauthenticated call here always 401s, breaking
    // every one of this helper's ~28 callers. Decrypt the tenant's own key above and send it, same
    // as checkAgentHealth already does for the callers that also call that separately.
    const getAgentDetails = await this.commonService.httpGet(
      `${baseWalletDetails?.agentEndpoint}${CommonConstants.URL_AGENT_GET_ENDPOINT}`,
      { headers: { authorization: decryptedApiKey } }
    );
    if (!getAgentDetails?.isInitialized) {
      throw new BadRequestException(ResponseMessages.cloudWallet.error.notReachable);
    }

    return [baseWalletDetails, decryptedApiKey];
  }

  /**
   * Create clous wallet
   * @param cloudWalletDetails
   * @returns cloud wallet details
   */
  async createCloudWallet(cloudWalletDetails: ICreateCloudWallet): Promise<IStoredWalletDetails> {
    // Tracks whether this call is the one holding a claimed capacity slot, so the catch block
    // below knows whether there is anything to release. Declared outside the try so it's visible
    // there regardless of which line inside the try throws.
    let capacityClaimed = false;
    let claimedBaseWalletId: string | undefined;
    try {
      const { label, connectionImageUrl, email, userId } = cloudWalletDetails;
      const agentPayload = {
        config: {
          label,
          connectionImageUrl
        }
      };

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(userId, CloudWalletType.SUB_WALLET);

      if (checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.userExist);
      }

      // Picks an active base wallet that still has capacity, deterministically -- not just
      // whichever active row Postgres returns first. The previous plain findFirstOrThrow (no
      // capacity predicate, no ordering) could reject creation with a full wallet A while an
      // empty wallet B sat idle, and which of the two got picked wasn't even reproducible between
      // calls. See the #71 review.
      const baseWalletDetails = await this.cloudWalletRepository.getAvailableBaseWallet();

      if (!baseWalletDetails) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.BaseWalletLimitExceeded);
      }

      // The read above only reflects capacity as of a moment ago -- two concurrent requests can
      // both read the same base wallet with room for exactly one more tenant and both proceed past
      // this point, over-provisioning it past maxSubWallets. claimBaseWalletCapacity is the actual
      // claim: an atomic conditional UPDATE that succeeds only if the row still has room at the
      // instant it runs, so at most one of two racing callers wins it. Done before the remote
      // agent call (not after, where the old incrementBaseWalletUseCount ran) so nothing remote
      // happens on a slot this request didn't actually secure. Released in the catch below if
      // anything past this point fails, so a failed creation doesn't permanently burn capacity it
      // never used. See the #71 review.
      const claimed = await this.cloudWalletRepository.claimBaseWalletCapacity(
        baseWalletDetails.id,
        baseWalletDetails.maxSubWallets
      );
      if (!claimed) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.BaseWalletLimitExceeded);
      }
      capacityClaimed = true;
      claimedBaseWalletId = baseWalletDetails.id;

      const { agentEndpoint, agentApiKey } = baseWalletDetails;
      if (!agentEndpoint || !agentApiKey) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.notFoundBaseWallet);
      }
      const url = `${agentEndpoint}${CommonConstants.URL_SHAGENT_CREATE_TENANT}`;
      const decryptedApiKey = await this.commonService.decryptPassword(agentApiKey);

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);

      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }
      const createCloudWalletResponse = await this.commonService.httpPost(url, agentPayload, {
        headers: { authorization: decryptedApiKey }
      });

      if (!createCloudWalletResponse && !createCloudWalletResponse.id) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.createCloudWallet, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      // createTenant's response is { token, ...tenantRecord } — Credo 0.6.2's TenantConfig is
      // just { label: string }, no walletConfig. Matches the agentApiKey assignment below, which
      // already reads the same top-level field correctly.
      const walletKey = await this.commonService.dataEncryption(createCloudWalletResponse.token);

      if (!walletKey) {
        throw new BadRequestException(ResponseMessages.cloudWallet.error.encryptCloudWalletKey, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      const cloudWalletResponse: ICloudWalletDetails = {
        createdBy: userId,
        label,
        lastChangedBy: userId,
        tenantId: createCloudWalletResponse.id,
        type: CloudWalletType.SUB_WALLET,
        userId,
        agentApiKey: this.commonService.dataEncryption(createCloudWalletResponse.token),
        agentEndpoint,
        email,
        key: walletKey,
        connectionImageUrl
      };
      // The capacity claim above already incremented useCount -- this call no longer does, it
      // only persists the sub-wallet's own row. See claimBaseWalletCapacity's docblock.
      const storeCloudWalletDetails = await this.cloudWalletRepository.storeCloudWalletDetails(cloudWalletResponse);
      return storeCloudWalletDetails;
    } catch (error) {
      // Release a claimed slot on any failure past that point -- the tenant was never actually
      // created (or its record never actually persisted), so the capacity this request claimed
      // must go back to the pool rather than being burned on a request that didn't use it. A
      // second, unrelated failure here (the DB write itself failing) is logged and swallowed
      // rather than replacing the real error below -- best-effort, same as the old post-hoc
      // increment's own failure handling.
      if (capacityClaimed && claimedBaseWalletId) {
        await this.cloudWalletRepository.decrementBaseWalletUseCount(claimedBaseWalletId).catch((releaseError) => {
          this.logger.error(`[createCloudWallet] - failed to release claimed base wallet capacity: ${releaseError}`);
        });
      }
      this.logger.error(`[createCloudWallet] - error in create cloud wallet: ${error}`);
      await this.commonService.handleError(error);
    }
  }

  /**
   * Receive invitation
   * @param ReceiveInvitationDetails
   * @returns Invitation details
   */
  async receiveInvitationByUrl(ReceiveInvitationDetails: IReceiveInvitation): Promise<Response> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { email, userId, ...invitationDetails } = ReceiveInvitationDetails;

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(userId, CloudWalletType.SUB_WALLET);

      if (!checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.walletNotExist);
      }
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);

      const { agentEndpoint } = baseWalletDetails;
      const url = `${agentEndpoint}${CommonConstants.RECEIVE_INVITATION_BY_URL}`;

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);

      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }
      const receiveInvitationResponse = await this.commonService.httpPost(url, invitationDetails, {
        headers: { authorization: decryptedApiKey }
      });

      if (!receiveInvitationResponse) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.receiveInvitation, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      return receiveInvitationResponse;
    } catch (error) {
      this.logger.error(`[createCloudWallet] - error in receive invitation: ${error}`);
      await this.commonService.handleError(error);
    }
  }

  /**
   * Accept offer
   * @param acceptOfferDetails
   * @returns Offer details
   */
  async acceptOffer(acceptOfferDetails: IAcceptOffer): Promise<Response> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { email, userId, ...offerDetails } = acceptOfferDetails;

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(userId, CloudWalletType.SUB_WALLET);

      if (!checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.walletNotExist);
      }
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.ACCEPT_OFFER}`;

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);

      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }
      const acceptOfferResponse = await this.commonService.httpPost(url, offerDetails, {
        headers: { authorization: decryptedApiKey }
      });

      if (!acceptOfferResponse) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.receiveInvitation, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      return acceptOfferResponse;
    } catch (error) {
      this.logger.error(`[receiveInvitationByUrl] - error in accept offer: ${error}`);
      await this.commonService.handleError(error);
    }
  }

  /**
   * Create DID for cloud wallet
   * @param createDidDetails
   * @returns DID details
   */
  async createDid(createDidDetails: ICreateCloudWalletDid): Promise<Response> {
    try {
      // isDefault forwarded through, not stripped: agent-controller's DidController.writeDid
      // (#75) now accepts isDefault and tags the created DID's own DidRecord when set, and
      // getDidList (below) reads that same tag via GET /dids?isDefault=true. Stripping it here
      // would make the read side permanently return an empty list -- no cloud wallet could ever
      // have a default DID. See the #71 review.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { email, userId, ...didDetails } = createDidDetails;

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(userId, CloudWalletType.SUB_WALLET);

      if (!checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.walletNotExist);
      }
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.URL_AGENT_WRITE_DID}`;

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);

      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }
      const didDetailsResponse = await this.commonService.httpPost(url, didDetails, {
        headers: { authorization: decryptedApiKey }
      });

      if (!didDetailsResponse) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.receiveInvitation, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      return didDetailsResponse;
    } catch (error) {
      this.logger.error(`[createDid] - error in create DID: ${error}`);
      await this.commonService.handleError(error);
    }
  }

  /**
   * Get DID list by tenant id
   * @param walletDetails
   * @returns DID list
   */
  async getDidList(walletDetails: IWalletDetailsForDidList): Promise<IProofRequestRes[]> {
    try {
      const { userId, isDefault } = walletDetails;

      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);

      const { agentEndpoint } = baseWalletDetails;

      // isDefault forwarded as a query param, not silently dropped: agent-controller's GET /dids
      // (DidController.getDids) now accepts ?isDefault=true and answers from its own DidRecord tag
      // query -- see the agent-controller #75 review. Previously this threw NotImplementedException
      // for any isDefault request since there was nothing on the agent side to forward it to.
      const url = isDefault
        ? `${agentEndpoint}${CommonConstants.URL_AGENT_GET_DID}?isDefault=true`
        : `${agentEndpoint}${CommonConstants.URL_AGENT_GET_DID}`;

      const didList = (await this.commonService.httpGet(url, { headers: { authorization: decryptedApiKey } })) ?? [];
      return didList;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get connection details by tenant id and connection id
   * @param connectionDetails
   * @returns Connection Details
   */
  async getconnectionById(connectionDetails: IConnectionDetailsById): Promise<Response> {
    try {
      const { userId, connectionId } = connectionDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_CONNECTION_BY_ID}/${connectionId}`;

      const connectionDetailResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return connectionDetailResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get connection list by tenant id
   * @param connectionDetails
   * @returns Connection Details
   */
  async getAllconnectionById(connectionDetails: GetAllCloudWalletConnections): Promise<Response> {
    try {
      const { userId, alias, myDid, outOfBandId, theirDid, theirLabel } = connectionDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const urlOptions = {
        alias,
        myDid,
        outOfBandId,
        theirDid,
        theirLabel
      };
      const optionalParameter = await this.commonService.createDynamicUrl(urlOptions);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_CONNECTION_BY_ID}${optionalParameter}`;

      const connectionDetailList = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return connectionDetailList;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get credential list by tenant id
   * @param tenantDetails
   * @returns Connection Details
   */
  async getCredentialListById(tenantDetails: ITenantDetail): Promise<Response> {
    try {
      const { userId, connectionId, state, threadId } = tenantDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const urlOptions = {
        connectionId,
        state,
        threadId
      };
      const optionalParameter = await this.commonService.createDynamicUrl(urlOptions);

      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_CREDENTIAL}${optionalParameter}`;

      const credentialDetailResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return credentialDetailResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get credential by record id
   * @param credentialDetails
   * @returns Connection Details
   */
  async getCredentialByRecord(credentialDetails: ICredentialDetails): Promise<Response> {
    try {
      const { userId, credentialRecordId } = credentialDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;
      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_CREDENTIAL}/${credentialRecordId}`;

      const credentialDetailResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return credentialDetailResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get basic-message by connection id
   * @param connectionDetails
   * @returns Basic message Details
   */
  async getBasicMessageByConnectionId(connectionDetails: IBasicMessage): Promise<Response> {
    try {
      const { userId, connectionId } = connectionDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_BASIC_MESSAGE}${connectionId}`;

      const basicMessageResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return basicMessageResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Send basic-message by connection id
   * @param messageDetails
   * @returns Basic message Details
   */
  async sendBasicMessage(messageDetails: IBasicMessageDetails): Promise<Response> {
    try {
      const { userId, connectionId, content } = messageDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_BASIC_MESSAGE}${connectionId}`;
      const basicMessageResponse = await this.commonService.httpPost(
        url,
        { content },
        {
          headers: { authorization: decryptedApiKey }
        }
      );
      return basicMessageResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Start a native wallet export job against agent-controller. Async: returns { jobId, status }
   * immediately — poll getExportWalletStatus for the actual completion result (download URL +
   * checksum). tenantId comes from the platform's own record, not the caller — the agent-side
   * export endpoint (agent-controller PR #72) takes it from the path, not the request body.
   * @param exportWallet
   * @returns { jobId, status }
   */
  async exportCloudWallet(exportWallet: IExportCloudWallet): Promise<Response> {
    try {
      const { userId, passKey } = exportWallet;

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(userId, CloudWalletType.SUB_WALLET);
      if (!checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.walletNotExist);
      }

      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { tenantId } = await this.cloudWalletRepository.getCloudSubWallet(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.URL_CLOUD_WALLET_EXPORT}${tenantId}`;

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);
      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }

      // POST /multi-tenancy/export/:tenantId requires the *base* wallet's own token, not the
      // tenant token decryptedApiKey holds (that one's only valid against /agent, which is what
      // checkAgentHealth just used it for) -- every /multi-tenancy/* route rejects a tenant-scoped
      // token lacking the Basewallet scope. Same fix as checkCloudWalletStatus/deleteCloudWallet.
      const baseWalletApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);

      const exportWalletResponse = await this.commonService.httpPost(
        url,
        { passKey },
        {
          headers: { authorization: baseWalletApiKey }
        }
      );

      if (!exportWalletResponse) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.exportWallet, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      return exportWalletResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Poll the status of an export job started via exportCloudWallet. On completion, the response
   * carries a short-lived pre-signed S3 download URL and the artifact's SHA-256 checksum.
   * @param jobStatus
   * @returns the WalletPortabilityJobRecord, as reported by agent-controller
   */
  async getExportWalletStatus(jobStatus: IWalletPortabilityJobStatus): Promise<Response> {
    try {
      const { userId, jobId } = jobStatus;
      const [baseWalletDetails] = await this._commonCloudWalletInfo(userId);
      const { tenantId } = await this.cloudWalletRepository.getCloudSubWallet(userId);
      const { agentEndpoint } = baseWalletDetails;

      // encodeURIComponent as defense in depth -- the controller's ParseUUIDPipe already rejects
      // a malformed jobId before this is ever reached, but this keeps the call safe even if that
      // validation is ever loosened or bypassed. See the #71 review.
      const url = `${agentEndpoint}${CommonConstants.URL_CLOUD_WALLET_EXPORT}${tenantId}/status/${encodeURIComponent(jobId)}`;
      // Base wallet token required -- see exportCloudWallet's identical comment.
      const baseWalletApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);
      const statusResponse = await this.commonService.httpGet(url, {
        headers: { authorization: baseWalletApiKey }
      });

      if (!statusResponse) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.jobStatusNotFound);
      }

      return statusResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Check whether a user's cloud wallet tenant still exists on the agent
   * @param checkCloudWalletStatusPayload
   * @returns tenant record if the wallet still exists on the agent
   */
  async checkCloudWalletStatus(checkCloudWalletStatusPayload: ICheckCloudWalletStatus): Promise<Response> {
    try {
      const { userId } = checkCloudWalletStatusPayload;
      const cloudSubWalletDetails = await this.cloudWalletRepository.getCloudSubWallet(userId);
      if (!cloudSubWalletDetails || !cloudSubWalletDetails.tenantId) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.walletRecordNotFound);
      }

      // Resolved by the tenant's OWN agentEndpoint, not an arbitrary active BASE_WALLET row --
      // same fix, same reasoning as _commonCloudWalletInfo. This method can't use that helper
      // directly since it needs the *base* wallet's own token below, not the tenant's.
      const baseWalletDetails = await this.cloudWalletRepository.getBaseWalletByAgentEndpoint(
        cloudSubWalletDetails.agentEndpoint
      );
      if (!baseWalletDetails) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.notFoundBaseWallet);
      }

      // GET /multi-tenancy/:tenantId requires the *base* wallet's own token, not the tenant token
      // _commonCloudWalletInfo returns — every /multi-tenancy/* route rejects a tenant-scoped
      // token lacking the Basewallet scope. See the closed #74 PR review.
      const decryptedApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);
      const url = `${baseWalletDetails.agentEndpoint}${CommonConstants.CLOUD_WALLET_DELETE_BY_TENANT_ID}${cloudSubWalletDetails.tenantId}`;

      const tenantStatusResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return tenantStatusResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Delete a user's cloud wallet: removes the tenant on the agent and the platform record
   * @param deleteCloudWalletPayload
   * @returns deleted cloud wallet record
   */
  // eslint-disable-next-line camelcase
  async deleteCloudWallet(deleteCloudWalletPayload: IDeleteCloudWallet): Promise<cloud_wallet_user_info> {
    try {
      const { userId } = deleteCloudWalletPayload;
      const cloudSubWalletDetails = await this.cloudWalletRepository.getCloudSubWallet(userId);
      if (!cloudSubWalletDetails || !cloudSubWalletDetails.tenantId) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.walletRecordNotFound);
      }

      // Resolved by the tenant's OWN agentEndpoint, not an arbitrary active BASE_WALLET row --
      // same fix, same reasoning as _commonCloudWalletInfo/checkCloudWalletStatus.
      const baseWalletDetails = await this.cloudWalletRepository.getBaseWalletByAgentEndpoint(
        cloudSubWalletDetails.agentEndpoint
      );
      if (!baseWalletDetails) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.notFoundBaseWallet);
      }

      // Base-wallet scope required for /multi-tenancy/:tenantId — same reasoning as
      // checkCloudWalletStatus above.
      const decryptedApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);
      const url = `${baseWalletDetails.agentEndpoint}${CommonConstants.CLOUD_WALLET_DELETE_BY_TENANT_ID}${cloudSubWalletDetails.tenantId}`;

      const deleteTenantResponse = await this.commonService.httpDelete(url, {
        headers: { authorization: decryptedApiKey }
      });

      if (
        !deleteTenantResponse ||
        (HttpStatus.OK !== deleteTenantResponse.status && HttpStatus.NO_CONTENT !== deleteTenantResponse.status)
      ) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.deleteCloudWallet, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      const deletedCloudWalletDetails = await this.cloudWalletRepository.deleteCloudWalletDetails(
        cloudSubWalletDetails.id
      );
      // Best-effort, mirroring createCloudWallet's own claim: the tenant is already deleted
      // on the agent and the row is already gone here -- log rather than fail an already-
      // successful delete over a counter update. Without this, useCount only ever goes up (see
      // claimBaseWalletCapacity's own docblock), permanently leaking capacity that a real
      // deletion should have freed. See the #73 review.
      await this.cloudWalletRepository
        .decrementBaseWalletUseCount(baseWalletDetails.id)
        .catch((error) =>
          this.logger.error(`[deleteCloudWallet] - failed to decrement base wallet useCount: ${error}`)
        );
      return deletedCloudWalletDetails;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Start a native wallet import job against agent-controller. Async: returns { jobId, status }
   * immediately — poll getImportWalletStatus for the actual completion result (backupProfile).
   * exportUrl/checksum/passKey are the values returned by a prior export job.
   * @param importWallet
   * @returns { jobId, status }
   */
  async importCloudWallet(importWallet: IImportCloudWallet): Promise<Response> {
    try {
      const { email, userId, exportUrl, checksum, passKey } = importWallet;

      const checkUserExist = await this.cloudWalletRepository.checkUserExist(email);
      if (!checkUserExist) {
        throw new ConflictException(ResponseMessages.cloudWallet.error.walletNotExist);
      }

      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { tenantId } = await this.cloudWalletRepository.getCloudSubWallet(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.URL_CLOUD_WALLET_IMPORT}${tenantId}`;

      const checkCloudWalletAgentHealth = await this.commonService.checkAgentHealth(agentEndpoint, decryptedApiKey);
      if (!checkCloudWalletAgentHealth) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.agentNotRunning);
      }

      // POST /multi-tenancy/import/:tenantId requires the *base* wallet's own token, not the
      // tenant token decryptedApiKey holds (that one's only valid against /agent, which is what
      // checkAgentHealth just used it for) -- every /multi-tenancy/* route rejects a tenant-scoped
      // token lacking the Basewallet scope. Same fix as checkCloudWalletStatus/deleteCloudWallet
      // (and exportCloudWallet, on the stacked feat/cloud-wallet-export branch).
      const baseWalletApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);

      const importWalletResponse = await this.commonService.httpPost(
        url,
        { exportUrl, checksum, passKey },
        {
          headers: { authorization: baseWalletApiKey }
        }
      );

      if (!importWalletResponse) {
        throw new InternalServerErrorException(ResponseMessages.cloudWallet.error.importWallet, {
          cause: new Error(),
          description: ResponseMessages.errorMessages.serverError
        });
      }

      return importWalletResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get all configured base wallets and their current capacity
   * @returns base wallet info list
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getBaseWalletDetails(user: user): Promise<BaseAgentInfo[]> {
    try {
      const baseWallets = await this.cloudWalletRepository.getAllBaseWallets();
      return baseWallets.map(({ id, agentEndpoint, isActive, useCount, maxSubWallets }) => ({
        id,
        agentEndpoint,
        isActive,
        useCount,
        maxSubWallets
      }));
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Update a base wallet's active flag / sub-wallet capacity
   * @param updateBaseWalletPayload
   * @returns updated base wallet info
   */
  async updateBaseWalletDetails(updateBaseWalletPayload: IUpdateBaseWallet): Promise<BaseAgentInfo[]> {
    try {
      const { walletId, isActive, maxSubWallets } = updateBaseWalletPayload;
      const updatedWallet = await this.cloudWalletRepository.updateBaseWallet(walletId, isActive, maxSubWallets);

      return [
        {
          id: updatedWallet.id,
          agentEndpoint: updatedWallet.agentEndpoint,
          isActive: updatedWallet.isActive,
          useCount: updatedWallet.useCount,
          maxSubWallets: updatedWallet.maxSubWallets
        }
      ];
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get all W3C credentials for a tenant
   * @param w3cCredentialsDetails
   * @returns W3C credential list
   */
  async getAllW3cCredentials(w3cCredentialsDetails: IW3cCredentials): Promise<Response> {
    try {
      const { userId } = w3cCredentialsDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_W3C_CREDENTIAL}`;

      const w3cCredentialsResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return w3cCredentialsResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get a W3C credential by its record id
   * @param w3cCredentialDetails
   * @returns W3C credential
   */
  async getW3cCredentialByCredentialRecordId(w3cCredentialDetails: IW3cCredentials): Promise<Response> {
    try {
      const { userId, credentialRecordId } = w3cCredentialDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_W3C_CREDENTIAL}/${credentialRecordId}`;

      const w3cCredentialResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return w3cCredentialResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get a credential's format data by its record id
   * @param credentialDetails
   * @returns credential format data
   */
  async getCredentialFormatDataByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    try {
      const { userId, credentialRecordId } = credentialDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_CREDENTIAL}/${credentialRecordId}${CommonConstants.CLOUD_WALLET_CREDENTIAL_FORMAT_DATA}`;

      const credentialFormatDataResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return credentialFormatDataResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Get a proof presentation's format data by its record id
   * @param proofPresentationDetails
   * @returns proof presentation format data
   */
  async getProofFormatDataByProofRecordId(proofPresentationDetails: IProofPresentationDetails): Promise<Response> {
    try {
      const { userId, proofRecordId } = proofPresentationDetails;
      const [baseWalletDetails, decryptedApiKey] = await this._commonCloudWalletInfo(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/${proofRecordId}${CommonConstants.CLOUD_WALLET_PROOF_FORM_DATA}`;

      const proofFormatDataResponse = await this.commonService.httpGet(url, {
        headers: { authorization: decryptedApiKey }
      });
      return proofFormatDataResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }

  /**
   * Poll the status of an import job started via importCloudWallet. On completion, the response
   * carries backupProfile — the name the tenant's pre-import profile was renamed to.
   * @param jobStatus
   * @returns the WalletPortabilityJobRecord, as reported by agent-controller
   */
  async getImportWalletStatus(jobStatus: IWalletPortabilityJobStatus): Promise<Response> {
    try {
      const { userId, jobId } = jobStatus;
      const [baseWalletDetails] = await this._commonCloudWalletInfo(userId);
      const { tenantId } = await this.cloudWalletRepository.getCloudSubWallet(userId);
      const { agentEndpoint } = baseWalletDetails;

      const url = `${agentEndpoint}${CommonConstants.URL_CLOUD_WALLET_IMPORT}${tenantId}/status/${jobId}`;
      // Base wallet token required -- see importCloudWallet's identical comment.
      const baseWalletApiKey = await this.commonService.decryptPassword(baseWalletDetails.agentApiKey);
      const statusResponse = await this.commonService.httpGet(url, {
        headers: { authorization: baseWalletApiKey }
      });

      if (!statusResponse) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.jobStatusNotFound);
      }

      return statusResponse;
    } catch (error) {
      await this.commonService.handleError(error);
      throw error;
    }
  }
}
