import {
  IAcceptOffer,
  ICreateCloudWallet,
  ICreateCloudWalletDid,
  IReceiveInvitation,
  IAcceptProofRequest,
  IProofRequestRes,
  ICloudBaseWalletConfigure,
  IGetProofPresentation,
  IGetProofPresentationById,
  IGetStoredWalletInfo,
  IStoredWalletDetails,
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
  IProofPresentationDetails,
  BaseAgentInfo,
  IW3cCredentials,
  IExportCloudWallet,
  IDeclineProofRequest,
  IProofPresentationPayloadWithCred,
  ICredentialForRequestRes,
  IDeleteCloudWallet,
  IImportCloudWallet,
  IWalletPortabilityJobStatus
} from '@credebl/common/interfaces/cloud-wallet.interface';
// eslint-disable-next-line camelcase
import { cloud_wallet_user_info, user } from '@prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import { BaseService } from 'libs/service/base.service';
import { NATSClient } from '@credebl/common/NATSClient';
import { ClientProxy } from '@nestjs/microservices';
import { UpdateBaseWalletDto } from './dtos/cloudWallet.dto';
import { SelfAttestedCredentialDto } from './dtos/self-attested-credential.dto';

@Injectable()
export class CloudWalletService extends BaseService {
  constructor(
    @Inject('NATS_CLIENT') private readonly cloudWalletServiceProxy: ClientProxy,
    // User lifecycle (delete-user) lives on apps/user's queue group, not apps/cloud-wallet's.
    @Inject('USER_NATS_CLIENT') private readonly userServiceProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {
    super('CloudWalletServiceProxy');
  }

  async configureBaseWallet(cloudBaseWalletConfigure: ICloudBaseWalletConfigure): Promise<IGetStoredWalletInfo> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'configure-cloud-base-wallet',
      cloudBaseWalletConfigure
    );
  }

  checkCloudWalletStatus(acceptProofRequest: ICheckCloudWalletStatus): Promise<IProofRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'check-cloud-wallet-status',
      acceptProofRequest
    );
  }

  createConnection(createConnection: ICreateConnection): Promise<IConnectionInvitationResponse> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'create-connection-by-holder',
      createConnection
    );
  }

  acceptProofRequest(acceptProofRequest: IAcceptProofRequest): Promise<IProofRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'accept-proof-request-by-holder',
      acceptProofRequest
    );
  }

  declineProofRequest(acceptProofRequest: IDeclineProofRequest): Promise<IProofRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'decline-proof-request-by-holder',
      acceptProofRequest
    );
  }

  getProofById(proofPresentationByIdPayload: IGetProofPresentationById): Promise<IProofRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-proof-by-proof-id-holder',
      proofPresentationByIdPayload
    );
  }

  submitProofWithCred(proofPresentationByIdPayload: IProofPresentationPayloadWithCred): Promise<IProofRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'submit-proof-with-cred',
      proofPresentationByIdPayload
    );
  }
  getCredentialsForRequest(proofPresentationByIdPayload: IProofPresentationDetails): Promise<ICredentialForRequestRes> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-credentials-for-request',
      proofPresentationByIdPayload
    );
  }
  getProofPresentation(proofPresentationPayload: IGetProofPresentation): Promise<IProofRequestRes[]> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-proof-presentation-holder',
      proofPresentationPayload
    );
  }

  createCloudWallet(cloudWalletDetails: ICreateCloudWallet): Promise<IStoredWalletDetails> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'create-cloud-wallet', cloudWalletDetails);
  }

  async deleteCloudWallet(
    cloudWalletDetails: IDeleteCloudWallet
    // eslint-disable-next-line camelcase
  ): Promise<cloud_wallet_user_info> {
    // eslint-disable-next-line camelcase
    const res: cloud_wallet_user_info = await this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'delete-cloud-wallet',
      cloudWalletDetails
    );
    if (cloudWalletDetails.deleteHolder) {
      // userId comes from the caller's own payload, not the NATS reply — a handler that returns
      // null/undefined (nothing found, or a void handler) would otherwise throw here *after* the
      // wallet delete already committed, leaving the holder user orphaned with no way to retry.
      // Also dispatched on the user service's own proxy: user lifecycle lives in apps/user, not
      // apps/cloud-wallet.
      await this.natsClient.sendNatsMessage(this.userServiceProxy, 'delete-user', cloudWalletDetails.userId);
    }
    return res;
  }

  getBaseWalletDetails(user: user): Promise<BaseAgentInfo[]> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'get-base-wallet-details', user);
  }

  updateBaseWalletDetails(updateBaseWalletDto: UpdateBaseWalletDto): Promise<BaseAgentInfo[]> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'update-base-wallet-details',
      updateBaseWalletDto
    );
  }

  receiveInvitationByUrl(ReceiveInvitationDetails: IReceiveInvitation): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'receive-invitation-by-url',
      ReceiveInvitationDetails
    );
  }

  acceptOffer(acceptOfferDetails: IAcceptOffer): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'accept-credential-offer', acceptOfferDetails);
  }

  createDid(createDidDetails: ICreateCloudWalletDid): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'create-cloud-wallet-did', createDidDetails);
  }

  exportWallet(exportWallet: IExportCloudWallet): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'export-cloud-wallet', exportWallet);
  }

  getExportWalletStatus(jobStatus: IWalletPortabilityJobStatus): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'get-export-wallet-status', jobStatus);
  }

  importWallet(importWallet: IImportCloudWallet): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'import-cloud-wallet', importWallet);
  }

  getImportWalletStatus(jobStatus: IWalletPortabilityJobStatus): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'get-import-wallet-status', jobStatus);
  }

  getDidList(
    walletDetails: IWalletDetailsForDidList
  ): Promise<IProofRequestRes[] | (Record<string, unknown> & { hashTenantID: string })> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'cloud-wallet-did-list', walletDetails);
  }

  getconnectionById(connectionDetails: IConnectionDetailsById): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-cloud-wallet-connection-by-id',
      connectionDetails
    );
  }
  getAllconnectionById(connectionDetails: GetAllCloudWalletConnections): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-all-cloud-wallet-connections-list-by-id',
      connectionDetails
    );
  }

  getCredentialList(tenantDetails: ITenantDetail): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'wallet-credential-by-id', tenantDetails);
  }

  getAllW3cCredentials(w3cCredentials: IW3cCredentials): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'get-all-w3c-credenentials', w3cCredentials);
  }

  getW3cCredentialByCredentialRecordId(w3CcredentialDetail: IW3cCredentials): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'get-w3c-credential-by-record-id',
      w3CcredentialDetail
    );
  }

  getCredentialByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'wallet-credential-by-record-id',
      credentialDetails
    );
  }

  getCredentialFormatDataByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'wallet-credentialFormatData-by-record-id',
      credentialDetails
    );
  }

  getProofFormatDataByProofRecordId(credentialDetails: IProofPresentationDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'wallet-Proof-presentation-FormatData-by-record-id',
      credentialDetails
    );
  }

  deleteCredentialByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'delete-credential-by-record-id',
      credentialDetails
    );
  }

  deleteW3cCredentialByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'delete-w3c-credential-by-record-id',
      credentialDetails
    );
  }

  getBasicMessageByConnectionId(connectionDetails: IBasicMessage): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'basic-message-list-by-connection-id',
      connectionDetails
    );
  }

  sendBasicMessage(messageDetails: IBasicMessageDetails): Promise<Response> {
    return this.natsClient.sendNatsMessage(this.cloudWalletServiceProxy, 'send-basic-message', messageDetails);
  }

  createSelfAttestedW3cCredential(selfAttestedCredentialDto: SelfAttestedCredentialDto): Promise<Response> {
    return this.natsClient.sendNatsMessage(
      this.cloudWalletServiceProxy,
      'create-self-attested-w3c-credential',
      selfAttestedCredentialDto
    );
  }
}
