// eslint-disable-next-line camelcase
import { ForbiddenException, HttpException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { EcosystemRepository } from './ecosystem.repository';
import { ResponseMessages } from '@credebl/common/response-messages';
import { BulkSendInvitationDto } from '../dtos/send-invitation.dto';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { PrismaService } from '@credebl/prisma-service';
import { EcosystemInviteTemplate } from '../templates/EcosystemInviteTemplate';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { sendEmail } from '@credebl/common/send-grid-helper-file';
import { AcceptRejectEcosystemInvitationDto } from '../dtos/accept-reject-ecosysteminvitation.dto';
import { Invitation, OrgAgentType } from '@credebl/enum/enum';
import { EcosystemOrgStatus, EcosystemRoles } from '../enums/ecosystem.enum';
import { FetchInvitationsPayload } from '../interfaces/invitations.interface';
import { GetEndorsementsPayload } from '../interfaces/endorsements.interface';
import { RequestSchemaEndorsement, SchemaMessage, SchemaTransactionPayload, SchemaTransactionResponse, SignedTransactionMessage } from '../interfaces/ecosystem.interfaces';
// eslint-disable-next-line camelcase
import { platform_config } from '@prisma/client';
import { CommonConstants } from '@credebl/common/common.constant';

@Injectable()
export class EcosystemService {
  constructor(
    @Inject('NATS_CLIENT') private readonly ecosystemServiceProxy: ClientProxy,
    private readonly ecosystemRepository: EcosystemRepository,
    private readonly logger: Logger,
    private readonly prisma: PrismaService

  ) { }

  /**
   *
   * @param createEcosystemDto
   * @returns
   */

  // eslint-disable-next-line camelcase
  async createEcosystem(createEcosystemDto): Promise<object> {
    const createEcosystem = await this.ecosystemRepository.createNewEcosystem(createEcosystemDto);
    if (!createEcosystem) {
      throw new NotFoundException(ResponseMessages.ecosystem.error.update);
    }
    return createEcosystem;
  }


  /**
  *
  * @param editEcosystemDto
  * @returns
  */

  // eslint-disable-next-line camelcase
  async editEcosystem(editEcosystemDto, ecosystemId): Promise<object> {
    const editOrganization = await this.ecosystemRepository.updateEcosystemById(editEcosystemDto, ecosystemId);
    if (!editOrganization) {
      throw new NotFoundException(ResponseMessages.ecosystem.error.update);
    }
    return editOrganization;
  }

  /**
   *
   *
   * @returns all ecosystem details
   */

  // eslint-disable-next-line camelcase
  async getAllEcosystem(payload: {orgId: string}): Promise<object> {
      const getAllEcosystemDetails = await this.ecosystemRepository.getAllEcosystemDetails(payload.orgId);
      if (!getAllEcosystemDetails) {
        throw new NotFoundException(ResponseMessages.ecosystem.error.update);
      }
      return getAllEcosystemDetails;
    } 


  /**
    * Description: get an ecosystem invitation 
    * @returns Get sent ecosystem invitation details
    */

  // eslint-disable-next-line camelcase
  async getEcosystemInvitations(userEmail: string, status: string, pageNumber: number, pageSize: number, search: string): Promise<object> {

    try {
      const query = {
        AND: [
          { email: userEmail },
          { status: { contains: search, mode: 'insensitive' } }
        ]
      };

      return await this.ecosystemRepository.getEcosystemInvitationsPagination(query, pageNumber, pageSize);
    } catch (error) {
      this.logger.error(`In error getEcosystemInvitations: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  /**
   * 
   * @param bulkInvitationDto 
   * @param userId 
   * @returns 
   */
  async createInvitation(bulkInvitationDto: BulkSendInvitationDto, userId: string): Promise<string> {
    const { invitations, ecosystemId } = bulkInvitationDto;

    try {
      const ecosystemDetails = await this.ecosystemRepository.getEcosystemDetails(ecosystemId);

      for (const invitation of invitations) {
        const { email } = invitation;

        const isInvitationExist = await this.checkInvitationExist(email, ecosystemId);

        if (!isInvitationExist) {
          await this.ecosystemRepository.createSendInvitation(email, ecosystemId, userId);

          try {
            await this.sendInviteEmailTemplate(email, ecosystemDetails.name);
          } catch (error) {
            throw new InternalServerErrorException(ResponseMessages.user.error.emailSend);
          }
        }
      }
      return ResponseMessages.ecosystem.success.createInvitation;
    } catch (error) {
      this.logger.error(`In send Invitation : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @param acceptRejectEcosystemInvitation
   * @param userId
   * @returns Ecosystem invitation status
   */
  async acceptRejectEcosystemInvitations(acceptRejectInvitation: AcceptRejectEcosystemInvitationDto): Promise<string> {
    try {
      const { orgId, status, invitationId } = acceptRejectInvitation;
      const invitation = await this.ecosystemRepository.getEcosystemInvitationById(invitationId);
      
      if (!invitation) {
        throw new NotFoundException(ResponseMessages.ecosystem.error.invitationNotFound);
      }

      const updatedInvitation = await this.updateEcosystemInvitation(invitationId, orgId, status);
      if (!updatedInvitation) {
         throw new NotFoundException(ResponseMessages.ecosystem.error.invitationNotUpdate);
      }

      if (status === Invitation.REJECTED) {
        return ResponseMessages.ecosystem.success.invitationReject;
      }

      const ecosystemRole = await this.ecosystemRepository.getEcosystemRole(EcosystemRoles.ECOSYSTEM_MEMBER);
      const updateEcosystemOrgs = await this.updatedEcosystemOrgs(orgId, invitation.ecosystemId, ecosystemRole.id);

      if (!updateEcosystemOrgs) {
        throw new NotFoundException(ResponseMessages.ecosystem.error.orgsNotUpdate);
      }
      return ResponseMessages.ecosystem.success.invitationAccept;
    
    } catch (error) {
      this.logger.error(`acceptRejectInvitations: ${error}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }
  
  async updatedEcosystemOrgs(orgId: string, ecosystemId: string, ecosystemRoleId: string): Promise<object> {
    try {
      const data = {
        orgId,
        status: EcosystemOrgStatus.ACTIVE,
        ecosystemId,
        ecosystemRoleId
      };
      return await this.ecosystemRepository.updateEcosystemOrgs(data);
    } catch (error) {
      this.logger.error(`In newEcosystemMneber : ${error}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * 
   * @param payload 
   * @returns Updated invitation response
   */
  async updateEcosystemInvitation(invitationId: string, orgId: string, status: string): Promise<object> {
    try {
   
      const data = {
        status,
        orgId: String(orgId)
      };
      return this.ecosystemRepository.updateEcosystemInvitation(invitationId, data);

    } catch (error) {
      this.logger.error(`In updateOrgInvitation : ${error}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * 
   * @param email 
   * @param ecosystemId 
   * @returns Returns boolean status for invitation
   */
  async checkInvitationExist(
    email: string,
    ecosystemId: string
  ): Promise<boolean> {
    try {

      const query = {
        email,
        ecosystemId
      };

      const invitations = await this.ecosystemRepository.getEcosystemInvitations(query);

      if (0 < invitations.length) {
        return true;
      }
      return false;
    } catch (error) {
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * 
   * @param email 
   * @param ecosystemName 
   * @returns Send invitation mail 
   */
  async sendInviteEmailTemplate(
    email: string,
    ecosystemName: string
  ): Promise<boolean> {
    const platformConfigData = await this.prisma.platform_config.findMany();

    const urlEmailTemplate = new EcosystemInviteTemplate();
    const emailData = new EmailDto();
    emailData.emailFrom = platformConfigData[0].emailFrom;
    emailData.emailTo = email;
    emailData.emailSubject = `${process.env.PLATFORM_NAME} Platform: Invitation`;

    emailData.emailHtml = await urlEmailTemplate.sendInviteEmailTemplate(email, ecosystemName);

    //Email is sent to user for the verification through emailData
    const isEmailSent = await sendEmail(emailData);

    return isEmailSent;
  }

  /**
   * 
   * @param RequestSchemaEndorsement 
   * @returns 
   */
  async requestSchemaEndorsement(requestSchemaPayload: RequestSchemaEndorsement, orgId: number): Promise<object> {
    try {
      const agentDetails = await this.ecosystemRepository.getAgentDetails(orgId);
      // eslint-disable-next-line camelcase
      const platformConfig: platform_config = await this.ecosystemRepository.getPlatformConfigDetails();

      const url = await this.getAgentUrl(agentDetails?.orgAgentTypeId, agentDetails.agentEndPoint);

      const attributeArray = requestSchemaPayload.attributes.map(item => item.attributeName);

      const getEcosystemLeadDetails = await this.ecosystemRepository.getEcosystemLeadDetails();

      const ecosystemLeadAgentDetails = await this.ecosystemRepository.getAgentDetails(Number(getEcosystemLeadDetails.orgId));

      const getEcosystemOrgDetailsByOrgId = await this.ecosystemRepository.getEcosystemOrgDetailsbyId(String(orgId));

      const schemaTransactionPayload: SchemaTransactionPayload = {
        endorserDid: ecosystemLeadAgentDetails.orgDid,
        endorse: requestSchemaPayload.endorse,
        attributes: attributeArray,
        version: String(requestSchemaPayload.version),
        name: requestSchemaPayload.name,
        issuerId: agentDetails.orgDid
      };

      const schemaTransactionRequest: SchemaMessage = await this._requestSchemaEndorsement(schemaTransactionPayload, url, platformConfig?.sgApiKey);
      const schemaTransactionResponse: SchemaTransactionResponse = {
        endorserDid: ecosystemLeadAgentDetails.orgDid,
        authorDid: agentDetails.orgDid,
        requestPayload: schemaTransactionRequest.message.schemaState.schemaRequest,
        status: "Requested",
        ecosystemOrgId: getEcosystemOrgDetailsByOrgId.id
      };
      return this.ecosystemRepository.storeTransactionRequest(schemaTransactionResponse);
    } catch (error) {
      this.logger.error(`In request schema endorsement : ${JSON.stringify(error)}`);
 
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getInvitationsByEcosystemId(
    payload: FetchInvitationsPayload
    ): Promise<object> {
   try {

     const { ecosystemId, pageNumber, pageSize, search} = payload;
     const ecosystemInvitations = await this.ecosystemRepository.getInvitationsByEcosystemId(ecosystemId, pageNumber, pageSize, search);
     return ecosystemInvitations;
   } catch (error) {
     this.logger.error(`In getInvitationsByEcosystemId : ${JSON.stringify(error)}`);
     throw new RpcException(error.response ? error.response : error);
   }
 }
  /**
 * Description: Store shortening URL 
 * @param referenceId 
 * @param url 
 * @returns connection invitation URL
 */
  async _requestSchemaEndorsement(requestSchemaPayload: object, url: string, apiKey: string): Promise<object> {
    const pattern = { cmd: 'agent-schema-endorsement-request' };
    const payload = { requestSchemaPayload, url, apiKey };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.ecosystemServiceProxy.send<any>(pattern, payload).toPromise();
      return { message };
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      throw new HttpException({
        status: error.status,
        error: error.message
      }, error.status);
    }
  }

  async signTransaction(endorsementId: string): Promise<object> {
    try {
      const endorsementTransactionPayload = await this.ecosystemRepository.getEndorsementTransactionById(endorsementId);

      const getEcosystemLeadDetails = await this.ecosystemRepository.getEcosystemLeadDetails();
      // eslint-disable-next-line camelcase
      const platformConfig: platform_config = await this.ecosystemRepository.getPlatformConfigDetails();

      const ecosystemLeadAgentDetails = await this.ecosystemRepository.getAgentDetails(Number(getEcosystemLeadDetails.orgId));
      const url = `${ecosystemLeadAgentDetails.agentEndPoint}/transactions/endorse`;


      const parsedRequestPayload = JSON.parse(endorsementTransactionPayload.requestPayload);


      const payload = {
        transaction: JSON.stringify(parsedRequestPayload),
        endorserDid: endorsementTransactionPayload.endorserDid
      };

      const schemaTransactionRequest: SignedTransactionMessage = await this._signTransaction(payload, url, platformConfig.sgApiKey);
      return this.ecosystemRepository.updateTransactionDetails(endorsementId, schemaTransactionRequest.message.signedTransaction);

    } catch (error) {
      this.logger.error(`In sign transaction : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
     * Description: Store shortening URL 
     * @param signEndorsementPayload 
     * @param url 
     * @returns sign message
     */
  async _signTransaction(signEndorsementPayload: object, url: string, apiKey: string): Promise<object> {
    const pattern = { cmd: 'agent-sign-transaction' };
    const payload = { signEndorsementPayload, url, apiKey };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.ecosystemServiceProxy.send<any>(pattern, payload).toPromise();
      return { message };
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      throw new HttpException({
        status: error.status,
        error: error.message
      }, error.status);
    }
  }


  async getAgentUrl(
    orgAgentTypeId: number,
    agentEndPoint: string
  ): Promise<string> {
    try {

      let url;
      if (orgAgentTypeId === OrgAgentType.DEDICATED) {

        url = `${agentEndPoint}${CommonConstants.URL_SCHM_CREATE_SCHEMA}`;
      } else if (orgAgentTypeId === OrgAgentType.SHARED) {

        // TODO
        // url = `${agentEndPoint}${CommonConstants.URL_SHAGENT_CREATE_INVITATION}`.replace('#', tenantId);
      } else {

        throw new NotFoundException(ResponseMessages.connection.error.agentUrlNotFound);
      }
      return url;

    } catch (error) {
      this.logger.error(`Error in get agent url: ${JSON.stringify(error)}`);
      throw error;

    }
  }

  
  async fetchEcosystemOrg(
    payload: { ecosystemId: string, orgId: string}
  ): Promise<object> {

    const isEcosystemEnabled = await this.checkEcosystemEnableFlag();    

    if (!isEcosystemEnabled) {
      throw new ForbiddenException(ResponseMessages.ecosystem.error.ecosystemNotEnabled);
    }

    return this.ecosystemRepository.fetchEcosystemOrg(
      payload
    );
  }

  /**
   * 
   * @returns Returns ecosystem flag from settings
   */
  async checkEcosystemEnableFlag(
  ): Promise<boolean> {
    const platformConfigData = await this.prisma.platform_config.findMany();
    return platformConfigData[0].enableEcosystem;
  }

  async getEndorsementTransactions(payload: GetEndorsementsPayload): Promise<object> {
    const {ecosystemId, orgId, pageNumber, pageSize, search} = payload;
    try {

      const query = {
        ecosystemOrgs: {
          ecosystemId,
          orgId
        },
        OR: [
          { status: { contains: search, mode: 'insensitive' } },
          { authorDid: { contains: search, mode: 'insensitive' } }
        ]
      };

      const filterOptions = {};

      return await this.ecosystemRepository.getEndorsementsWithPagination(query, filterOptions, pageNumber, pageSize);
    } catch (error) {
      this.logger.error(`In error getEndorsementTransactions: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

}
