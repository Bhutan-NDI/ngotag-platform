/* eslint-disable prefer-destructuring */
// eslint-disable-next-line camelcase
import { org_invitations, organisation, user } from '@prisma/client';
import {
  Injectable,
  Logger,
  ConflictException,
  InternalServerErrorException,
  HttpException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException
} from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';
import { CommonService } from '@credebl/common';
import { OrganizationRepository } from '../repositories/organization.repository';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Inject, NotFoundException } from '@nestjs/common';
import { OrgRolesService } from '@credebl/org-roles';
import { OrgRoles } from 'libs/org-roles/enums';
import { UserOrgRolesService } from '@credebl/user-org-roles';
import { ResponseMessages } from '@credebl/common/response-messages';
import { OrganizationInviteTemplate } from '../templates/organization-invitation.template';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { sendEmail } from '@credebl/common/send-grid-helper-file';
import { CreateOrganizationDto } from '../dtos/create-organization.dto';
import { BulkSendInvitationDto } from '../dtos/send-invitation.dto';
import { UpdateInvitationDto } from '../dtos/update-invitation.dt';
import { Invitation, OrgAgentType, transition } from '@credebl/enum/enum';
import { IGetOrgById, IGetOrganization, IUpdateOrganization, IOrgAgent, IClientCredentials, ICreateConnectionUrl, IOrgRole } from '../interfaces/organization.interface';
import { UserActivityService } from '@credebl/user-activity';
import { CommonConstants } from '@credebl/common/common.constant';
import { ClientRegistrationService } from '@credebl/client-registration/client-registration.service';
import { map } from 'rxjs/operators';
import { Cache } from 'cache-manager';
import { AwsService } from '@credebl/aws';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  IOrgCredentials,
  IOrganization,
  IOrganizationInvitations,
  IOrganizationDashboard
} from '@credebl/common/interfaces/organization.interface';

import { ClientCredentialTokenPayloadDto } from '@credebl/client-registration/dtos/client-credential-token-payload.dto';
import { IAccessTokenData } from '@credebl/common/interfaces/interface';
import { IClientRoles } from '@credebl/client-registration/interfaces/client.interface';
@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commonService: CommonService,
    @Inject('NATS_CLIENT') private readonly organizationServiceProxy: ClientProxy,
    private readonly organizationRepository: OrganizationRepository,
    private readonly orgRoleService: OrgRolesService,
    private readonly userOrgRoleService: UserOrgRolesService,
    private readonly awsService: AwsService,
    private readonly userActivityService: UserActivityService,
    private readonly logger: Logger,
    @Inject(CACHE_MANAGER) private cacheService: Cache,
    private readonly clientRegistrationService: ClientRegistrationService
  ) {}

  /**
   *
   * @param registerOrgDto
   * @returns
   */

  // eslint-disable-next-line camelcase
  async createOrganization(
    createOrgDto: CreateOrganizationDto,
    userId: string,
    keycloakUserId: string
  ): Promise<organisation> {
    try {
      const organizationExist = await this.organizationRepository.checkOrganizationNameExist(createOrgDto.name);

      if (organizationExist) {
        throw new ConflictException(ResponseMessages.organisation.error.exists);
      }

      const orgSlug = this.createOrgSlug(createOrgDto.name);

      const isOrgSlugExist = await this.organizationRepository.checkOrganizationSlugExist(orgSlug);

      if (isOrgSlugExist) {
        throw new ConflictException(ResponseMessages.organisation.error.exists);
      }   

      createOrgDto.orgSlug = orgSlug;
      createOrgDto.createdBy = userId;
      createOrgDto.lastChangedBy = userId;

      if (await this.isValidBase64(createOrgDto?.logo)) {
        const imageUrl = await this.uploadFileToS3(createOrgDto.logo);
        createOrgDto.logo = imageUrl;
      } else {
        createOrgDto.logo = '';
      }

      const organizationDetails = await this.organizationRepository.createOrganization(createOrgDto);

      // To return selective object data
      delete organizationDetails.lastChangedBy;
      delete organizationDetails.lastChangedDateTime;
      delete organizationDetails.orgSlug;
      delete organizationDetails.website;

      try {
        const orgCredentials = await this.registerToKeycloak(
          organizationDetails.name,
          organizationDetails.id,
          keycloakUserId,
          userId,
          false
        );

        const { clientId, idpId } = orgCredentials;

        const updateOrgData = {
          clientId,
          idpId
        };
  
        const updatedOrg = await this.organizationRepository.updateOrganizationById(
          updateOrgData,
          organizationDetails.id
        );
  
        if (!updatedOrg) {
          throw new InternalServerErrorException(ResponseMessages.organisation.error.credentialsNotUpdate);
        }
      } catch (error) {
        this.logger.error(`Error In creating client : ${JSON.stringify(error)}`);
        throw new InternalServerErrorException('Unable to create client');
      }

      if (createOrgDto.notificationWebhook) {
        await this.storeOrgWebhookEndpoint(organizationDetails.id, createOrgDto.notificationWebhook);
      }

      await this.userActivityService.createActivity(
        userId,
        organizationDetails.id,
        `${organizationDetails.name} organization created`,
        'Get started with inviting users to join organization'
      );

      return organizationDetails;
    } catch (error) {
      this.logger.error(`In create organization : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @param orgId
   * @returns organization client credentials
   */
  async createOrgCredentials(orgId: string, userId: string, keycloakUserId: string): Promise<IOrgCredentials> {
    try {
      const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

      if (!organizationDetails) {
        throw new ConflictException(ResponseMessages.organisation.error.orgNotFound);
      }

      let updateOrgData = {};
      let generatedClientSecret = '';

      if (organizationDetails.idpId) {
        const token = await this.clientRegistrationService.getManagementToken();

        generatedClientSecret = await this.clientRegistrationService.generateClientSecret(
          organizationDetails.idpId,
          token
        );

        updateOrgData = {
          clientSecret: this.maskString(generatedClientSecret)
        };
      } else {

        try {
          const orgCredentials = await this.registerToKeycloak(
            organizationDetails.name,
            organizationDetails.id,
            keycloakUserId,
            userId,
            true
          );
  
          const { clientId, idpId, clientSecret } = orgCredentials;
  
          generatedClientSecret = clientSecret;
  
          updateOrgData = {
            clientId,
            clientSecret: this.maskString(clientSecret),
            idpId
          };
        } catch (error) {
          this.logger.error(`Error In creating client : ${JSON.stringify(error)}`);
          throw new InternalServerErrorException('Unable to create client');
        }
      }

      const updatedOrg = await this.organizationRepository.updateOrganizationById(updateOrgData, orgId);

      if (!updatedOrg) {
        throw new InternalServerErrorException(ResponseMessages.organisation.error.credentialsNotUpdate);
      }

      return {
        idpId: updatedOrg.idpId,
        clientId: updatedOrg.clientId,
        clientSecret: generatedClientSecret
      };
    } catch (error) {
      this.logger.error(`In createOrgCredentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Register the organization to keycloak
   * @param orgName
   * @param orgId
   * @returns client credentials
   */
  async registerToKeycloak(
    orgName: string,
    orgId: string,
    keycloakUserId: string,
    userId: string,
    shouldUpdateRole: boolean
  ): Promise<IOrgCredentials> {
    const token = await this.clientRegistrationService.getManagementToken();
    const orgDetails = await this.clientRegistrationService.createClient(orgName, orgId, token);

    const orgRolesList = [OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER];

      for (const role of orgRolesList) {
        await this.clientRegistrationService.createClientRole(orgDetails.idpId, token, role, role);
      }   

    const ownerRoleClient = await this.clientRegistrationService.getClientSpecificRoles(
      orgDetails.idpId,
      token,
      OrgRoles.OWNER
    );

    const payload = [
      {
        id: ownerRoleClient.id,
        name: ownerRoleClient.name
      }
    ];

    const ownerRoleData = await this.orgRoleService.getRole(OrgRoles.OWNER);

    if (!shouldUpdateRole) {

      await Promise.all([
        this.clientRegistrationService.createUserClientRole(orgDetails.idpId, token, keycloakUserId, payload),
        this.userOrgRoleService.createUserOrgRole(userId, ownerRoleData.id, orgId, ownerRoleClient.id)
      ]);
      
    } else {
      const roleIdList = [
        {
          roleId: ownerRoleData.id,
          idpRoleId: ownerRoleClient.id
        }
      ];     
      
      await Promise.all([
        this.clientRegistrationService.createUserClientRole(orgDetails.idpId, token, keycloakUserId, payload),
        this.userOrgRoleService.deleteOrgRoles(userId, orgId),
        this.userOrgRoleService.updateUserOrgRole(userId, orgId, roleIdList)
      ]);
    }

    return orgDetails;
  }

  async deleteClientCredentials(orgId: string): Promise<string> {
    const token = await this.clientRegistrationService.getManagementToken();

    const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

    if (!organizationDetails) {
      throw new NotFoundException(ResponseMessages.organisation.error.orgNotFound);
    }

    try {
      await this.clientRegistrationService.deleteClient(organizationDetails.idpId, token);
      const updateOrgData = {
        clientId: null,
        clientSecret: null,
        idpId: null
      };

      await this.organizationRepository.updateOrganizationById(updateOrgData, orgId);
    } catch (error) {
      throw new InternalServerErrorException('Unable to delete client credentails');
    }

    return ResponseMessages.organisation.success.deleteCredentials;
  }

  /**
   * Mask string and display last 5 characters
   * @param inputString
   * @returns
   */
  maskString(inputString: string): string {
    if (5 <= inputString.length) {
      // Extract the last 5 characters
      const lastFiveCharacters = inputString.slice(-8);

      // Create a masked string with '*' characters
      const maskedString = '*'.repeat(inputString.length - 8) + lastFiveCharacters;

      return maskedString;
    } else {
      // If the inputString is less than 5 characters, return the original string
      return inputString;
    }
  }

  async isValidBase64(value: string): Promise<boolean> {
    try {
      if (!value || 'string' !== typeof value) {
        return false;
      }

      const base64Regex = /^data:image\/([a-zA-Z]*);base64,([^\"]*)$/;
      const matches = value.match(base64Regex);
      return Boolean(matches) && 3 === matches.length;
    } catch (error) {
      return false;
    }
  }

  async uploadFileToS3(orgLogo: string): Promise<string> {
    try {
      const updatedOrglogo = orgLogo.split(',')[1];
      const imgData = Buffer.from(updatedOrglogo, 'base64');
      const logoUrl = await this.awsService.uploadUserCertificate(
        imgData,
        'png',
        'orgLogo',
        process.env.AWS_ORG_LOGO_BUCKET_NAME,
        'base64',
        'orgLogos'
      );
      return logoUrl;
    } catch (error) {
      this.logger.error(`In getting imageUrl : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @param orgName
   * @returns OrgSlug
   */
  createOrgSlug(orgName: string): string {
    return orgName
      .toLowerCase() // Convert the input to lowercase
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9-]/g, '') // Remove non-alphanumeric characters except hyphens
      .replace(/--+/g, '-'); // Replace multiple consecutive hyphens with a single hyphen
  }

  /**
   *
   * @param registerOrgDto
   * @returns
   */

  // eslint-disable-next-line camelcase
  async updateOrganization(updateOrgDto: IUpdateOrganization, userId: string, orgId: string): Promise<organisation> {
    try {

      const organizationExist = await this.organizationRepository.checkOrganizationNameExist(updateOrgDto.name);

      if (organizationExist && organizationExist.id !== orgId) {
        throw new ConflictException(ResponseMessages.organisation.error.exists);
      }

      const orgSlug = await this.createOrgSlug(updateOrgDto.name);
      updateOrgDto.orgSlug = orgSlug;
      updateOrgDto.userId = userId;

      if (await this.isValidBase64(updateOrgDto.logo)) {
        const imageUrl = await this.uploadFileToS3(updateOrgDto.logo);
        updateOrgDto.logo = imageUrl;
      } else {
        delete updateOrgDto.logo;
      }

      let organizationDetails;
      const checkAgentIsExists = await this.organizationRepository.getAgentInvitationDetails(orgId);

      if (!checkAgentIsExists?.connectionInvitation && !checkAgentIsExists?.agentId) {
      organizationDetails = await this.organizationRepository.updateOrganization(updateOrgDto);
      } else if (organizationDetails?.logoUrl !== organizationExist?.logoUrl || organizationDetails?.name !== organizationExist?.name) {
        const invitationData = await this._createConnection(updateOrgDto?.logo, updateOrgDto?.name, orgId);
        await this.organizationRepository.updateConnectionInvitationDetails(orgId, invitationData?.connectionInvitation);
      }

      await this.userActivityService.createActivity(userId, organizationDetails.id, `${organizationDetails.name} organization updated`, 'Organization details updated successfully');
      return organizationDetails;
    } catch (error) {
      this.logger.error(`In update organization : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }


  async _createConnection(
    orgName: string,
    logoUrl: string,
    orgId: string
  ): Promise<ICreateConnectionUrl> {
    const pattern = { cmd: 'create-connection' };

    const payload = {
      orgName,
      logoUrl,
      orgId
    };
    const connectionInvitationData = await this.organizationServiceProxy
      .send(pattern, payload)
      .toPromise()
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

    return connectionInvitationData;
  }
  
  /**
   * @returns Get created organizations details
   */

  async getOrganizations(
    userId: string,
    pageNumber: number,
    pageSize: number,
    search: string
  ): Promise<IGetOrganization> {
    try {
      const query = {
        userOrgRoles: {
          some: { userId }
        },
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      };

      const filterOptions = {
        userId
      };

      const getOrgs = await this.organizationRepository.getOrganizations(query, filterOptions, pageNumber, pageSize);
      return getOrgs;
    } catch (error) {
      this.logger.error(`In fetch getOrganizations : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async clientLoginCredentails(clientCredentials: IClientCredentials): Promise<IAccessTokenData> {
      const {clientId, clientSecret} = clientCredentials;
      return this.authenticateClientKeycloak(clientId, clientSecret);
}

  async authenticateClientKeycloak(clientId: string, clientSecret: string): Promise<IAccessTokenData> {
    
    try {
    const payload = new ClientCredentialTokenPayloadDto();
    // eslint-disable-next-line camelcase
    payload.client_id = clientId;
    // eslint-disable-next-line camelcase
    payload.client_secret = clientSecret;

    try {
      const mgmtTokenResponse = await this.clientRegistrationService.getToken(payload);
      return mgmtTokenResponse;
    } catch (error) {
      throw new UnauthorizedException(ResponseMessages.organisation.error.invalidClient);
    }

    } catch (error) {
      this.logger.error(`Error in authenticateClientKeycloak : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Description: get public organizations
   * @param
   * @returns Get public organizations details
   */

  async getPublicOrganizations(pageNumber: number, pageSize: number, search: string): Promise<IGetOrganization> {
    try {
      const query = {
        publicProfile: true,
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      };

      const filterOptions = {};

      return this.organizationRepository.getOrganizations(query, filterOptions, pageNumber, pageSize);
    } catch (error) {
      this.logger.error(`In fetch getPublicOrganizations : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getPublicProfile(payload: { orgSlug: string }): Promise<IGetOrgById> {
    const { orgSlug } = payload;
    try {
      const query = {
        orgSlug,
        publicProfile: true
      };

      const organizationDetails = await this.organizationRepository.getOrganization(query);
      if (!organizationDetails) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgProfileNotFound);
      }

      const credDefs = await this.organizationRepository.getCredDefByOrg(organizationDetails.id);
      organizationDetails['credential_definitions'] = credDefs;
      return organizationDetails;
    } catch (error) {
      this.logger.error(`get user: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Description: get organization
   * @param orgId Registration Details
   * @returns Get created organization details
   */

  async getOrganization(orgId: string): Promise<IGetOrgById> {
    try {
      const query = {
        id: orgId
      };

      const organizationDetails = await this.organizationRepository.getOrganization(query);
      return organizationDetails;
    } catch (error) {
      this.logger.error(`In create organization : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   * Description: get invitation
   * @param orgId Registration Details
   * @returns Get created invitation details
   */

  async getInvitationsByOrgId(
    orgId: string,
    pageNumber: number,
    pageSize: number,
    search: string
  ): Promise<IOrganizationInvitations> {
    try {
      const getOrganization = await this.organizationRepository.getInvitationsByOrgId(
        orgId,
        pageNumber,
        pageSize,
        search
      );
      for await (const item of getOrganization['invitations']) {
        const getOrgRoles = await this.orgRoleService.getOrgRolesByIds(item['orgRoles']);
        (item['orgRoles'] as object) = getOrgRoles;
      }
      return getOrganization;
    } catch (error) {
      this.logger.error(`In create organization : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @returns organization roles
   */

  async getOrgRoles(orgId: string): Promise<IClientRoles[]> {
    try {
      if (!orgId) {
        throw new BadRequestException(ResponseMessages.organisation.error.orgIdIsRequired);
      }

      const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

      if (!organizationDetails) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgNotFound);
      }

      if (!organizationDetails.idpId) {
        return this.orgRoleService.getOrgRoles();
      }

      const token = await this.clientRegistrationService.getManagementToken();

      return this.clientRegistrationService.getAllClientRoles(organizationDetails.idpId, token);
    } catch (error) {
      this.logger.error(`In getOrgRoles : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @param email
   * @returns
   */
  async checkInvitationExist(email: string, orgId: string): Promise<boolean> {
    try {
      const query = {
        email,
        orgId
      };

      const invitations = await this.organizationRepository.getOrgInvitations(query);

      let isPendingInvitation = false;
      let isAcceptedInvitation = false;

      for (const invitation of invitations) {
        if (invitation.status === Invitation.PENDING) {
          isPendingInvitation = true;
        }
        if (invitation.status === Invitation.ACCEPTED) {
          isAcceptedInvitation = true;
        }
      }

      if (isPendingInvitation || isAcceptedInvitation) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`error: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async createInvitationByOrgRoles(
    bulkInvitationDto: BulkSendInvitationDto,
    userEmail: string,
    userId: string,
    orgName: string
    ): Promise<void> {
    const { invitations, orgId } = bulkInvitationDto;

      for (const invitation of invitations) {
        const { orgRoleId, email } = invitation;

        const isUserExist = await this.checkUserExistInPlatform(email);

        const userData = await this.getUserFirstName(userEmail);
        
        const {firstName} = userData;
        const orgRolesDetails = await this.orgRoleService.getOrgRolesByIds(orgRoleId);
       
        if (0 === orgRolesDetails.length) {
          throw new NotFoundException(ResponseMessages.organisation.error.orgRoleIdNotFound);
        }

        const isInvitationExist = await this.checkInvitationExist(email, orgId);

        if (!isInvitationExist && userEmail !== invitation.email) {

          await this.organizationRepository.createSendInvitation(email, String(orgId), String(userId), orgRoleId);

          try {
            await this.sendInviteEmailTemplate(email, orgName, orgRolesDetails, firstName, isUserExist);
          } catch (error) {
            throw new InternalServerErrorException(ResponseMessages.user.error.emailSend);
          }
        }
      }
  }

  async createInvitationByClientRoles(
    bulkInvitationDto: BulkSendInvitationDto,
    userEmail: string,
    userId: string,
    orgName: string,
    idpId: string
    ): Promise<void> {
    const { invitations, orgId } = bulkInvitationDto;

    const token = await this.clientRegistrationService.getManagementToken();
    const clientRolesList = await this.clientRegistrationService.getAllClientRoles(idpId, token);
    const orgRoles = await this.orgRoleService.getOrgRoles();

    for (const invitation of invitations) {
      const { orgRoleId, email } = invitation;

      const isUserExist = await this.checkUserExistInPlatform(email);

      const userData = await this.getUserFirstName(userEmail);

      const { firstName } = userData;

      const matchedRoles = clientRolesList
        .filter((role) => orgRoleId.includes(role.id.trim()))
        .map((role) => role.name);

      if (orgRoleId.length !== matchedRoles.length) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgRoleIdNotFound);
      }

      const filteredOrgRoles = orgRoles.filter((role) => matchedRoles.includes(role.name.trim()));

      const isInvitationExist = await this.checkInvitationExist(email, orgId);

      if (!isInvitationExist && userEmail !== invitation.email) {

        await this.organizationRepository.createSendInvitation(
          email,
          String(orgId),
          String(userId),
          filteredOrgRoles.map((role) => role.id)
        );

        try {
          await this.sendInviteEmailTemplate(
            email,
            orgName,
            filteredOrgRoles,
            firstName,
            isUserExist
          );
        } catch (error) {
          throw new InternalServerErrorException(ResponseMessages.user.error.emailSend);
        }
      }
    }
  }

  /**
   *
   * @Body sendInvitationDto
   * @returns createInvitation
   */

  async createInvitation(bulkInvitationDto: BulkSendInvitationDto, userId: string, userEmail: string): Promise<string> {
    const { orgId } = bulkInvitationDto;

    try {
      const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

      if (!organizationDetails) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgNotFound);
      }

      if (!organizationDetails.idpId) {
        await this.createInvitationByOrgRoles(
           bulkInvitationDto,
           userEmail,
           userId,
           organizationDetails.name
           );
      } else {
        await this.createInvitationByClientRoles(
          bulkInvitationDto,
          userEmail,
          userId,
          organizationDetails.name,
          organizationDetails.idpId
        );
      }

      await this.userActivityService.createActivity(
        userId,
        organizationDetails.id,
        `Invitations sent for ${organizationDetails.name}`,
        'Get started with user role management once invitations accepted'
      );
      return ResponseMessages.organisation.success.createInvitation;
    } catch (error) {
      this.logger.error(`In send Invitation : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  /**
   *
   * @param email
   * @param orgName
   * @param orgRolesDetails
   * @returns true/false
   */

  async sendInviteEmailTemplate(
    email: string,
    orgName: string,
    orgRolesDetails: object[],
    firstName: string,
    isUserExist: boolean
  ): Promise<boolean> {
    const platformConfigData = await this.prisma.platform_config.findMany();

    const urlEmailTemplate = new OrganizationInviteTemplate();
    const emailData = new EmailDto();
    emailData.emailFrom = platformConfigData[0].emailFrom;
    emailData.emailTo = email;
    emailData.emailSubject = `Invitation to join “${orgName}” on ${process.env.PLATFORM_NAME}`;

    emailData.emailHtml = await urlEmailTemplate.sendInviteEmailTemplate(
      email,
      orgName,
      orgRolesDetails,
      firstName,
      isUserExist
    );

    //Email is sent to user for the verification through emailData
    const isEmailSent = await sendEmail(emailData);

    return isEmailSent;
  }

  async checkUserExistInPlatform(email: string): Promise<boolean> {
    const pattern = { cmd: 'get-user-by-mail' };
    const payload = { email };

    const userData: user = await this.organizationServiceProxy
      .send(pattern, payload)
      .toPromise()
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
    if (userData?.isEmailVerified) {
      return true;
    }
    return false;
  }

  async getUserFirstName(userEmail: string): Promise<user> {
    const pattern = { cmd: 'get-user-by-mail' };
    const payload = { email: userEmail };

    const userData = await this.organizationServiceProxy
      .send(pattern, payload)
      .toPromise()
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
    return userData;
  }

  async getUserUserId(userId: string): Promise<user> {
    const pattern = { cmd: 'get-user-by-user-id' };
    // const payload = { id: userId };

    const userData = await this.organizationServiceProxy
      .send(pattern, userId)
      .toPromise()
      .catch((error) => {
        this.logger.error(`catch: ${JSON.stringify(error)}`);
        throw new HttpException(
          {
            status: error.status,
            error: error.error,
            message: error.message
          },
          error.status
        );
      });
    return userData;
  }

  async fetchUserInvitation(
    email: string,
    status: string,
    pageNumber: number,
    pageSize: number,
    search = ''
  ): Promise<IOrganizationInvitations> {
    try {
      return this.organizationRepository.getAllOrgInvitations(email, status, pageNumber, pageSize, search);
    } catch (error) {
      this.logger.error(`In fetchUserInvitation : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async updateClientInvitation(
    // eslint-disable-next-line camelcase
    invitation: org_invitations,
    idpId: string,
    userId: string,
    keycloakUserId: string,
    orgId: string,
    status: string
  ): Promise<void> {
    const token = await this.clientRegistrationService.getManagementToken();
      const clientRolesList = await this.clientRegistrationService.getAllClientRoles(idpId, token);

      const orgRoles = await this.orgRoleService.getOrgRolesByIds(invitation.orgRoles);

      const rolesPayload: { roleId: string; name: string; idpRoleId: string }[] = orgRoles.map((orgRole: IOrgRole) => {
        let roleObj: { roleId: string;  name: string; idpRoleId: string} = null;

        for (let index = 0; index < clientRolesList.length; index++) {
          if (clientRolesList[index].name === orgRole.name) {
            roleObj = {
              roleId: orgRole.id,
              name: orgRole.name,
              idpRoleId: clientRolesList[index].id
            };
            break;
          }
        }

        return roleObj;
      });

      const data = {
        status
      };

      await Promise.all([
        this.organizationRepository.updateOrgInvitation(invitation.id, data),
        this.clientRegistrationService.createUserClientRole(idpId, token, keycloakUserId, rolesPayload.map(role => ({id: role.idpRoleId, name: role.name}))),
        this.userOrgRoleService.updateUserOrgRole(userId, orgId, rolesPayload)
      ]);

  }

  /**
   *
   * @param payload
   * @returns Updated invitation response
   */
  async updateOrgInvitation(payload: UpdateInvitationDto): Promise<string> {
    try {
      const { orgId, status, invitationId, userId, keycloakUserId, email } = payload;
      const invitation = await this.organizationRepository.getInvitationById(String(invitationId));

      if (!invitation || (invitation && invitation.email !== email)) {
        throw new NotFoundException(ResponseMessages.user.error.invitationNotFound);
      }

      if (invitation.orgId !== orgId) {
        throw new NotFoundException(ResponseMessages.user.error.invalidOrgId);
      }

      const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

      if (!organizationDetails) {
        throw new ConflictException(ResponseMessages.organisation.error.orgNotFound);
      }

      const invitationStatus = invitation.status as Invitation;
      if (!transition(invitationStatus, payload.status)) {
        throw new BadRequestException(
          `${ResponseMessages.user.error.invitationStatusUpdateInvalid} ${invitation.status}`
        );
      }

      const data = {
        status
      };

      if (status === Invitation.REJECTED) {
        await this.organizationRepository.updateOrgInvitation(invitationId, data);
        return ResponseMessages.user.success.invitationReject;
      }

      if (organizationDetails.idpId) {
        await this.updateClientInvitation(invitation, organizationDetails.idpId, userId, keycloakUserId, orgId, status);
      } else {
        await this.organizationRepository.updateOrgInvitation(invitationId, data);

        for (const roleId of invitation.orgRoles) {
          await this.userOrgRoleService.createUserOrgRole(userId, roleId, orgId);
        }
      }

      return ResponseMessages.user.success.invitationAccept;
    } catch (error) {
      this.logger.error(`In updateOrgInvitation : ${error}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async updateUserClientRoles(
    // eslint-disable-next-line camelcase
    roleIds: string[],
    idpId: string,
    userId: string,
    orgId: string
  ): Promise<boolean> {
    const token = await this.clientRegistrationService.getManagementToken();
    const clientRolesList = await this.clientRegistrationService.getAllClientRoles(
      idpId,
      token
    );
    const orgRoles = await this.orgRoleService.getOrgRoles();

    const matchedClientRoles = clientRolesList.filter((role) => roleIds.includes(role.id.trim()));

    if (roleIds.length !== matchedClientRoles.length) {
      throw new NotFoundException(ResponseMessages.organisation.error.orgRoleIdNotFound);
    }

    const rolesPayload: { roleId: string; name: string; idpRoleId: string }[] = matchedClientRoles.map(
      (clientRole: IClientRoles) => {
        let roleObj: { roleId: string; name: string; idpRoleId: string } = null;

        for (let index = 0; index < orgRoles.length; index++) {
          if (orgRoles[index].name === clientRole.name) {
            roleObj = {
              roleId: orgRoles[index].id,
              name: orgRoles[index].name,
              idpRoleId: clientRole.id
            };
            break;
          }
        }

        return roleObj;
      }
    );

    const userData = await this.getUserUserId(userId);

    const [, deletedUserRoleRecords] = await Promise.all([
      this.clientRegistrationService.deleteUserClientRoles(
        idpId,
        token,
        userData.keycloakUserId
      ),
      this.userOrgRoleService.deleteOrgRoles(userId, orgId)
    ]);

    if (0 === deletedUserRoleRecords['count']) {
      throw new InternalServerErrorException(ResponseMessages.organisation.error.updateUserRoles);
    }

    const [, isUserRoleUpdated] = await Promise.all([
      this.clientRegistrationService.createUserClientRole(
        idpId,
        token,
        userData.keycloakUserId,
        rolesPayload.map((role) => ({ id: role.idpRoleId, name: role.name }))
      ),
      this.userOrgRoleService.updateUserOrgRole(userId, orgId, rolesPayload)
    ]);

    return isUserRoleUpdated;
  }

  /**
   *
   * @param orgId
   * @param roleIds
   * @param userId
   * @returns
   */
  async updateUserRoles(orgId: string, roleIds: string[], userId: string): Promise<boolean> {
    try {
      const isUserExistForOrg = await this.userOrgRoleService.checkUserOrgExist(userId, orgId);

      if (!isUserExistForOrg) {
        throw new NotFoundException(ResponseMessages.organisation.error.userNotFound);
      }

      const organizationDetails = await this.organizationRepository.getOrganizationDetails(orgId);

      if (!organizationDetails) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgNotFound);
      }

      if (!organizationDetails.idpId) {
        const isRolesExist = await this.orgRoleService.getOrgRolesByIds(roleIds);

        if (isRolesExist && 0 === isRolesExist.length) {
          throw new NotFoundException(ResponseMessages.organisation.error.rolesNotExist);
        }

        const deleteUserRecords = await this.userOrgRoleService.deleteOrgRoles(userId, orgId);

        if (0 === deleteUserRecords['count']) {
          throw new InternalServerErrorException(ResponseMessages.organisation.error.updateUserRoles);
        }

        for (const role of roleIds) {
          this.userOrgRoleService.createUserOrgRole(userId, role, orgId);
        }

        return true;
      } else {

        return this.updateUserClientRoles(
          roleIds,
          organizationDetails.idpId,
          userId,
          organizationDetails.id          
        );      
      }

    } catch (error) {
      this.logger.error(`Error in updateUserRoles: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getOrgDashboard(orgId: string): Promise<IOrganizationDashboard> {
    try {
      return this.organizationRepository.getOrgDashboard(orgId);
    } catch (error) {
      this.logger.error(`In create organization : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getOrgPofile(orgId: string): Promise<organisation> {
    try {
      const orgProfile = await this.organizationRepository.getOrgProfile(orgId);
      if (!orgProfile.logoUrl || '' === orgProfile.logoUrl) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgProfile);
      }
      return orgProfile;
    } catch (error) {
      this.logger.error(`get organization profile : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async fetchOrgCredentials(orgId: string): Promise<IOrgCredentials> {
    try {
      const orgCredentials = await this.organizationRepository.getOrganizationDetails(orgId);
      if (!orgCredentials.clientId) {
        throw new NotFoundException(ResponseMessages.organisation.error.notExistClientCred);
      }
      return {
        clientId: orgCredentials.clientId,
        clientSecret: orgCredentials.clientSecret
      };
    } catch (error) {
      this.logger.error(`Error in fetchOrgCredentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getOrgOwner(orgId: string): Promise<IOrganization> {
    try {
      const orgDetails = await this.organizationRepository.getOrganizationOwnerDetails(orgId, OrgRoles.OWNER);
      return orgDetails;
    } catch (error) {
      this.logger.error(`get organization profile : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async deleteOrganization(orgId: string): Promise<boolean> {
    try {
      const getAgent = await this.organizationRepository.getAgentEndPoint(orgId);
      // const apiKey = await this._getOrgAgentApiKey(orgId);
      let apiKey: string = await this.cacheService.get(CommonConstants.CACHE_APIKEY_KEY);
      if (!apiKey || null === apiKey || undefined === apiKey) {
        apiKey = await this._getOrgAgentApiKey(orgId);
      }
      let url;
      if (getAgent.orgAgentTypeId === OrgAgentType.DEDICATED) {
        url = `${getAgent.agentEndPoint}${CommonConstants.URL_DELETE_WALLET}`;
      } else if (getAgent.orgAgentTypeId === OrgAgentType.SHARED) {
        url = `${getAgent.agentEndPoint}${CommonConstants.URL_DELETE_SHARED_WALLET}`.replace('#', getAgent.tenantId);
      }

      const payload = {
        url,
        apiKey
      };

      const deleteWallet = await this._deleteWallet(payload);
      if (deleteWallet) {
        const orgDelete = await this.organizationRepository.deleteOrg(orgId);
        if (false === orgDelete) {
          throw new NotFoundException(ResponseMessages.organisation.error.deleteOrg);
        }
      }

      return true;
    } catch (error) {
      this.logger.error(`delete organization: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _deleteWallet(payload: IOrgAgent): Promise<{
    response;
  }> {
    try {
      const pattern = {
        cmd: 'delete-wallet'
      };

      return this.organizationServiceProxy
        .send<string>(pattern, payload)
        .pipe(
          map((response) => ({
            response
          }))
        )
        .toPromise()
        .catch((error) => {
          this.logger.error(`catch: ${JSON.stringify(error)}`);
          throw new HttpException(
            {
              status: error.statusCode,
              error: error.message
            },
            error.error
          );
        });
    } catch (error) {
      this.logger.error(`[_deleteWallet] - error in delete wallet : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async _getOrgAgentApiKey(orgId: string): Promise<string> {
    const pattern = { cmd: 'get-org-agent-api-key' };
    const payload = { orgId };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.organizationServiceProxy.send<any>(pattern, payload).toPromise();
      return message;
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      throw new HttpException(
        {
          status: error.status,
          error: error.message
        },
        error.status
      );
    }
  }

  async registerOrgsMapUsers(): Promise<string> {

    try {

      const unregisteredOrgsList = await this.organizationRepository.getUnregisteredClientOrgs();
      
      if (!unregisteredOrgsList || 0 === unregisteredOrgsList.length) {
        throw new NotFoundException('Unregistered client organizations not found');
      }      

      for (const org of unregisteredOrgsList) {
        const userOrgRoles = 0 < org['userOrgRoles'].length && org['userOrgRoles'];

        const ownerUserList = 0 < org['userOrgRoles'].length 
        && userOrgRoles.filter(userOrgRole => userOrgRole.orgRole.name === OrgRoles.OWNER);

        const ownerUser = 0 < ownerUserList.length && ownerUserList[0].user;

        const orgObj = {
          id: org.id,
          idpId: org.idpId,
          name: org.name,
          ownerId: ownerUser.id,
          ownerEmail: ownerUser.email,
          ownerKeycloakId: ownerUser.keycloakUserId
        };

        if (orgObj.ownerKeycloakId) {
          const orgCredentials = await this.registerToKeycloak(
            orgObj.name,
            orgObj.id,
            orgObj.ownerKeycloakId,
            orgObj.ownerId,
            true
          );

          const { clientId, idpId, clientSecret } = orgCredentials;
    
          const updateOrgData = {
            clientId,
            clientSecret: this.maskString(clientSecret),
            idpId
          };

          const updatedOrg = await this.organizationRepository.updateOrganizationById(updateOrgData, orgObj.id);
          
          this.logger.log(`updatedOrg::`, updatedOrg);

          const usersToRegisterList = userOrgRoles.filter(userOrgRole => null !== userOrgRole.user.keycloakUserId);
          
            const token = await this.clientRegistrationService.getManagementToken();
            const clientRolesList = await this.clientRegistrationService.getAllClientRoles(idpId, token);

            const deletedUserDetails: string[] = [];
            for (const userRole of usersToRegisterList) {
              const user = userRole.user;

              const matchedClientRoles = clientRolesList.filter((role) => userRole.orgRole.name === role.name)
              .map(clientRole => ({roleId: userRole.orgRole.id, idpRoleId: clientRole.id, name: clientRole.name}));

              if (!deletedUserDetails.includes(user.id)) {
                const [, deletedUserRoleRecords] = await Promise.all([
                  this.clientRegistrationService.deleteUserClientRoles(idpId, token, user.keycloakUserId),
                  this.userOrgRoleService.deleteOrgRoles(user.id, orgObj.id)
                ]);
  
                this.logger.log(`deletedUserRoleRecords::`, deletedUserRoleRecords);

                deletedUserDetails.push(user.id);
              }

           
              await Promise.all([
                this.clientRegistrationService.createUserClientRole(
                  idpId,
                  token,
                  user.keycloakUserId,
                  matchedClientRoles.map((role) => ({ id: role.idpRoleId, name: role.name }))
                ),
                this.userOrgRoleService.updateUserOrgRole(
                  user.id,
                  orgObj.id,
                  matchedClientRoles.map((role) => ({ roleId: role.roleId, idpRoleId: role.idpRoleId }))
                )
              ]);
              this.logger.log(`Organization client created and users mapped to roles`);

            }      
        }      
      }
     
      return '';
    } catch (error) {
      this.logger.error(`Error in registerOrgsMapUsers: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);

    }
  }

  async deleteOrganizationInvitation(orgId: string, invitationId: string): Promise<boolean> {
    try {
      const invitationDetails = await this.organizationRepository.getInvitationById(invitationId);

      // Check invitation is present
      if (!invitationDetails) {
        throw new NotFoundException(ResponseMessages.user.error.invitationNotFound);
      }

      // Check if delete process initiated by the org who has created invitation
      if (orgId !== invitationDetails.orgId) {
        throw new ForbiddenException(ResponseMessages.organisation.error.deleteOrgInvitation);
      }

      // Check if invitation is already accepted/rejected
      if (Invitation.PENDING !== invitationDetails.status) {
        throw new BadRequestException(ResponseMessages.organisation.error.invitationStatusInvalid);
      }

      await this.organizationRepository.deleteOrganizationInvitation(invitationId);

      return true;
    } catch (error) {
      this.logger.error(`delete organization invitation: ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async storeOrgWebhookEndpoint(orgId: string, notificationWebhook: string): Promise<string> {
    const pattern = { cmd: 'register-org-webhook-endpoint-for-notification' };
    const payload = {
      orgId,
      notificationWebhook
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = await this.organizationServiceProxy.send<any>(pattern, payload).toPromise();
      return message;
    } catch (error) {
      this.logger.error(`catch: ${JSON.stringify(error)}`);
      throw new HttpException(
        {
          status: error.status,
          error: error.message
        },
        error.status
      );
    }
  }
}
