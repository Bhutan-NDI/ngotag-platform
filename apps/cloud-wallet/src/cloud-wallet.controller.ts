/* eslint-disable @typescript-eslint/no-explicit-any */
import { Controller } from '@nestjs/common'; // Import the common service in the library
import { CloudWalletService } from './cloud-wallet.service'; // Import the common service in connection module
import { MessagePattern } from '@nestjs/microservices'; // Import the nestjs microservices package
import {
  IAcceptOffer,
  ICreateCloudWalletDid,
  IReceiveInvitation,
  IAcceptProofRequest,
  IProofRequestRes,
  ICloudBaseWalletConfigure,
  ICreateCloudWallet,
  IGetProofPresentation,
  IGetProofPresentationById,
  IGetStoredWalletInfo,
  IStoredWalletDetails,
  ICreateConnection,
  IConnectionInvitationResponse,
  IWalletDetailsForDidList,
  IConnectionDetailsById,
  ITenantDetail,
  ICredentialDetails,
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
  IWalletPortabilityJobStatus
} from '@credebl/common/interfaces/cloud-wallet.interface';
// eslint-disable-next-line camelcase
import { cloud_wallet_user_info, user } from '@prisma/client';

@Controller()
export class CloudWalletController {
  constructor(private readonly cloudWalletService: CloudWalletService) {}

  @MessagePattern({ cmd: 'configure-cloud-base-wallet' })
  async configureBaseWallet(configureBaseWalletPayload: ICloudBaseWalletConfigure): Promise<IGetStoredWalletInfo> {
    return this.cloudWalletService.configureBaseWallet(configureBaseWalletPayload);
  }

  @MessagePattern({ cmd: 'create-connection-by-holder' })
  async createConnection(createConnection: ICreateConnection): Promise<IConnectionInvitationResponse> {
    return this.cloudWalletService.createConnection(createConnection);
  }

  @MessagePattern({ cmd: 'accept-proof-request-by-holder' })
  async acceptProofRequest(acceptProofRequestPayload: IAcceptProofRequest): Promise<IProofRequestRes> {
    return this.cloudWalletService.acceptProofRequest(acceptProofRequestPayload);
  }

  @MessagePattern({ cmd: 'get-proof-by-proof-id-holder' })
  async getProofById(proofPrsentationByIdPayload: IGetProofPresentationById): Promise<IProofRequestRes> {
    return this.cloudWalletService.getProofById(proofPrsentationByIdPayload);
  }

  @MessagePattern({ cmd: 'get-proof-presentation-holder' })
  async getProofPresentation(proofPresentationPayload: IGetProofPresentation): Promise<IProofRequestRes[]> {
    return this.cloudWalletService.getProofPresentation(proofPresentationPayload);
  }

  @MessagePattern({ cmd: 'create-cloud-wallet' })
  async createConnectionInvitation(cloudWalletDetails: ICreateCloudWallet): Promise<IStoredWalletDetails> {
    return this.cloudWalletService.createCloudWallet(cloudWalletDetails);
  }

  @MessagePattern({ cmd: 'receive-invitation-by-url' })
  async receiveInvitationByUrl(ReceiveInvitationDetails: IReceiveInvitation): Promise<Response> {
    return this.cloudWalletService.receiveInvitationByUrl(ReceiveInvitationDetails);
  }

  @MessagePattern({ cmd: 'accept-credential-offer' })
  async acceptOffer(acceptOfferDetails: IAcceptOffer): Promise<Response> {
    return this.cloudWalletService.acceptOffer(acceptOfferDetails);
  }

  @MessagePattern({ cmd: 'create-cloud-wallet-did' })
  async createDid(createDidDetails: ICreateCloudWalletDid): Promise<Response> {
    return this.cloudWalletService.createDid(createDidDetails);
  }

  @MessagePattern({ cmd: 'cloud-wallet-did-list' })
  async getDidList(walletDetails: IWalletDetailsForDidList): Promise<IProofRequestRes[]> {
    return this.cloudWalletService.getDidList(walletDetails);
  }

  @MessagePattern({ cmd: 'get-cloud-wallet-connection-by-id' })
  async getconnectionById(connectionDetails: IConnectionDetailsById): Promise<Response> {
    return this.cloudWalletService.getconnectionById(connectionDetails);
  }

  @MessagePattern({ cmd: 'get-all-cloud-wallet-connections-list-by-id' })
  async getAllconnectionById(connectionDetails: GetAllCloudWalletConnections): Promise<Response> {
    return this.cloudWalletService.getAllconnectionById(connectionDetails);
  }

  @MessagePattern({ cmd: 'wallet-credential-by-id' })
  async getCredentialList(tenantDetails: ITenantDetail): Promise<Response> {
    return this.cloudWalletService.getCredentialListById(tenantDetails);
  }

  @MessagePattern({ cmd: 'wallet-credential-by-record-id' })
  async getCredentialByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.cloudWalletService.getCredentialByRecord(credentialDetails);
  }

  @MessagePattern({ cmd: 'basic-message-list-by-connection-id' })
  async getBasicMessageByConnectionId(connectionDetails: IBasicMessage): Promise<Response> {
    return this.cloudWalletService.getBasicMessageByConnectionId(connectionDetails);
  }

  @MessagePattern({ cmd: 'send-basic-message' })
  async sendBasicMessage(messageDetails: IBasicMessageDetails): Promise<Response> {
    return this.cloudWalletService.sendBasicMessage(messageDetails);
  }

  @MessagePattern({ cmd: 'export-cloud-wallet' })
  async exportCloudWallet(exportWallet: IExportCloudWallet): Promise<Response> {
    return this.cloudWalletService.exportCloudWallet(exportWallet);
  }

  @MessagePattern({ cmd: 'get-export-wallet-status' })
  async getExportWalletStatus(jobStatus: IWalletPortabilityJobStatus): Promise<Response> {
    return this.cloudWalletService.getExportWalletStatus(jobStatus);
  }

  @MessagePattern({ cmd: 'check-cloud-wallet-status' })
  async checkCloudWalletStatus(checkCloudWalletStatusPayload: ICheckCloudWalletStatus): Promise<Response> {
    return this.cloudWalletService.checkCloudWalletStatus(checkCloudWalletStatusPayload);
  }

  @MessagePattern({ cmd: 'delete-cloud-wallet' })
  // eslint-disable-next-line camelcase
  async deleteCloudWallet(deleteCloudWalletPayload: IDeleteCloudWallet): Promise<cloud_wallet_user_info> {
    return this.cloudWalletService.deleteCloudWallet(deleteCloudWalletPayload);
  }

  @MessagePattern({ cmd: 'get-base-wallet-details' })
  async getBaseWalletDetails(userDetails: user): Promise<BaseAgentInfo[]> {
    return this.cloudWalletService.getBaseWalletDetails(userDetails);
  }

  @MessagePattern({ cmd: 'update-base-wallet-details' })
  async updateBaseWalletDetails(updateBaseWalletPayload: IUpdateBaseWallet): Promise<BaseAgentInfo[]> {
    return this.cloudWalletService.updateBaseWalletDetails(updateBaseWalletPayload);
  }

  @MessagePattern({ cmd: 'get-all-w3c-credenentials' })
  async getAllW3cCredentials(w3cCredentialsDetails: IW3cCredentials): Promise<Response> {
    return this.cloudWalletService.getAllW3cCredentials(w3cCredentialsDetails);
  }

  @MessagePattern({ cmd: 'get-w3c-credential-by-record-id' })
  async getW3cCredentialByCredentialRecordId(w3cCredentialDetails: IW3cCredentials): Promise<Response> {
    return this.cloudWalletService.getW3cCredentialByCredentialRecordId(w3cCredentialDetails);
  }

  @MessagePattern({ cmd: 'wallet-credentialFormatData-by-record-id' })
  async getCredentialFormatDataByCredentialRecordId(credentialDetails: ICredentialDetails): Promise<Response> {
    return this.cloudWalletService.getCredentialFormatDataByCredentialRecordId(credentialDetails);
  }

  @MessagePattern({ cmd: 'wallet-Proof-presentation-FormatData-by-record-id' })
  async getProofFormatDataByProofRecordId(proofPresentationDetails: IProofPresentationDetails): Promise<Response> {
    return this.cloudWalletService.getProofFormatDataByProofRecordId(proofPresentationDetails);
  }
}
