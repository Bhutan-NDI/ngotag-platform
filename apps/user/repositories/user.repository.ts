/* eslint-disable camelcase */
/* eslint-disable prefer-destructuring */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from '@nestjs/common';
import {
  IOrgUsers,
  IRestrictedUserSession,
  ISendVerificationEmail,
  ISession,
  IShareUserCertificate,
  ITokenData,
  IUserDeletedActivity,
  IUserInformation,
  IUsersProfile,
  IVerifyUserEmail,
  PlatformSettings,
  UpdateUserProfile,
  UserKeycloakId,
  UserRoleDetails,
  UserRoleMapping
} from '../interfaces/user.interface';
import {
  Prisma,
  RecordType,
  account,
  client_aliases,
  schema,
  session,
  token,
  user,
  user_org_roles
} from '@prisma/client';
import { CloudWalletType, ProviderType, UserRole } from '@credebl/enum/enum';

import { PrismaService } from '@credebl/prisma-service';
import { ResponseMessages } from '@credebl/common/response-messages';
import { RpcException } from '@nestjs/microservices';

interface UserQueryOptions {
  id?: string; // Use the appropriate type based on your data model
  email?: string; // Use the appropriate type based on your data model
  username?: string;
  // Add more properties if needed for other unique identifier fields
}

@Injectable()
export class UserRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger
  ) {}

  /**
   *
   * @returns Client alias and its url
   */

  // eslint-disable-next-line camelcase
  async fetchClientAliases(): Promise<client_aliases[]> {
    try {
      return this.prisma.client_aliases.findMany();
    } catch (error) {
      this.logger.error(`checkUserExist: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   *
   * @param userEmailVerification
   * @returns user's email
   */
  async createUser(
    userEmailVerification: ISendVerificationEmail,
    verifyCode: string,
    isEmailVerified = false
  ): Promise<user> {
    try {
      const saveResponse = await this.prisma.user.upsert({
        where: {
          email: userEmailVerification.email
        },
        create: {
          username: userEmailVerification.username,
          email: userEmailVerification.email,
          verificationCode: verifyCode.toString(),
          clientId: userEmailVerification.clientId,
          clientSecret: userEmailVerification.clientSecret,
          publicProfile: true,
          // Invited users prove email ownership via their invitation link, so they are
          // created already verified in a single write (no separate verifyUser call).
          isEmailVerified
        },
        update: {
          verificationCode: verifyCode.toString()
        }
      });

      return saveResponse;
    } catch (error) {
      this.logger.error(`In Create User Repository: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   *
   * @param email
   * @returns User exist details
   */

  // eslint-disable-next-line camelcase
  async checkUserExist(email: string): Promise<user> {
    try {
      return this.prisma.user.findFirst({
        where: {
          email
        }
      });
    } catch (error) {
      this.logger.error(`checkUserExist: ${JSON.stringify(error)}`);
      throw new error();
    }
  }

  /**
   *
   * @param username
   * @returns User exist details, looked up by username rather than email — for the
   *   username-based (no email claim) signup/signin flow.
   */
  // eslint-disable-next-line camelcase
  async checkUserExistByUsername(username: string): Promise<user> {
    try {
      // Lowercased, matching createUserByUsername's own normalization below and the email flow's
      // existing userInfo.email.toLowerCase() pattern -- Keycloak lowercases usernames on create
      // (KeycloakModelUtils.toLowerCaseSafe), so a token's preferred_username claim is always
      // lowercase. Without normalizing here too, a user who signed up with a mixed-case username
      // (now accepted by findMatchingKeycloakUser's own case-insensitive fix) could log in, but
      // every subsequent lookup by the token's lowercased preferred_username (jwt.strategy ->
      // getUserByUsernameInKeycloak) would find no row and silently 403 with "not a holder" --
      // permanently, since the mismatch never resolves on its own. See the #71 review.
      return this.prisma.user.findFirst({
        where: {
          username: username?.toLowerCase()
        }
      });
    } catch (error) {
      this.logger.error(`checkUserExistByUsername: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   * Create a fresh user row for the username-based (no email) signup flow. Unlike
   * updateUserInfo, which only ever updates a row created earlier by the email flow's
   * sendVerificationMail/createUser upsert, there is no pre-existing row to update here — username
   * signup has no email-verification pre-step — so this is a plain insert.
   * @param userInfo
   * @param keycloakUserId
   * @returns created user
   */
  async createUserByUsername(
    userInfo: {
      username: string;
      firstName: string;
      lastName: string;
      clientId: string;
      clientSecret: string;
      isPasskey?: boolean;
      password?: string;
      email?: string;
    },
    keycloakUserId: string
  ): Promise<user> {
    try {
      return await this.prisma.user.create({
        data: {
          // Lowercased so this row matches what checkUserExistByUsername looks up and what
          // Keycloak's own preferred_username claim will always be, regardless of the case the
          // caller originally signed up with. See the #71 review.
          username: userInfo.username?.toLowerCase(),
          firstName: userInfo.firstName,
          lastName: userInfo.lastName,
          clientId: userInfo.clientId,
          clientSecret: userInfo.clientSecret,
          keycloakUserId,
          publicProfile: true,
          // Lowercased like username above -- the caller already lowercases it too, but enforcing
          // it here as well keeps the invariant at the write boundary, not just in one caller.
          // Needed for checkUserExist (email-based lookups, e.g. JwtStrategy) to find this row.
          email: userInfo.email?.toLowerCase(),
          // Only persisted for the passkey path — see login()'s isPasskey branch, which re-derives
          // this to bridge into Keycloak's password grant on future logins. Non-passkey users are
          // verified against Keycloak directly at login time; nothing to store here for them.
          ...(userInfo.isPasskey ? { password: userInfo.password } : {})
        }
      });
    } catch (error) {
      this.logger.error(`Error in createUserByUsername: ${JSON.stringify(error)}`);
      // email is @unique -- a placeholder colliding with an existing row (real or another
      // placeholder) would otherwise surface as an opaque 500 instead of a clear conflict.
      if (error instanceof Prisma.PrismaClientKnownRequestError && 'P2002' === error.code) {
        throw new ConflictException(ResponseMessages.user.error.exists);
      }
      throw error;
    }
  }

  /**
   * Delete a user and every row that references it. Only user_org_roles and user_role_mapping
   * cascade automatically at the DB level (onDelete: Cascade) — every other table in the deleteMany
   * list below defaults to RESTRICT, so prisma.user.delete alone throws a foreign-key violation for
   * any user that has ever logged in (a session/account/token row already exists). Wrapped in a
   * single transaction so a mid-way failure leaves nothing deleted.
   *
   * ecosystem_orgs and marketplace_subscription are deliberately NOT in the deleteMany list: unlike
   * every table above, those rows represent organisation/billing state, not user-profile state
   * — userId/localUserId there only records who added/purchased them. Both FKs are
   * ON DELETE SET NULL (ecosystem_orgs as of the migration alongside this fix; marketplace_subscription
   * already was), so the DB itself nulls the reference when this transaction's user.delete() runs,
   * rather than the row being destroyed. Deleting a user must never eject their organisations from
   * an ecosystem or drop billing records — see the #71 review.
   *
   * cloud_wallet_user_info's deleteMany is scoped to type: SUB_WALLET for the identical reason —
   * this table holds both a user's own cloud sub-wallet AND, for whoever configured it, a
   * BASE_WALLET row (@@unique([userId, type]) exists precisely so one person can hold both). An
   * unscoped deleteMany({where:{userId}}) would delete that admin's BASE_WALLET configuration too,
   * taking the whole cloud-wallet service down for every other user until it's reconfigured. See
   * the #71 review.
   * @param userId
   * @returns deleted user record
   */
  async deleteUserAndRelatedData(userId: string): Promise<user> {
    try {
      const results = await this.prisma.$transaction([
        this.prisma.token.deleteMany({ where: { userId } }),
        this.prisma.session.deleteMany({ where: { userId } }),
        this.prisma.account.deleteMany({ where: { userId } }),
        this.prisma.user_devices.deleteMany({ where: { userId } }),
        this.prisma.org_invitations.deleteMany({ where: { userId } }),
        this.prisma.user_activity.deleteMany({ where: { userId } }),
        this.prisma.ecosystem_invitations.deleteMany({ where: { userId } }),
        this.prisma.cloud_wallet_user_info.deleteMany({ where: { userId, type: CloudWalletType.SUB_WALLET } }),
        this.prisma.user.delete({ where: { id: userId } })
      ]);
      return results[results.length - 1] as user;
    } catch (error) {
      this.logger.error(`Error in deleteUserAndRelatedData: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   *
   * @param email
   * @returns User details
   */
  async getUserDetails(email: string): Promise<user> {
    try {
      return this.prisma.user.findFirst({
        where: {
          email
        }
      });
    } catch (error) {
      this.logger.error(`Not Found: ${JSON.stringify(error)}`);
      throw new NotFoundException(error);
    }
  }

  /**
   *
   * @param sessionId
   * @returns Session details
   */
  async getSession(sessionId: string): Promise<session> {
    try {
      return await this.prisma.session.findUnique({
        where: {
          id: sessionId
        }
      });
    } catch (error) {
      this.logger.error(`Not Found: ${JSON.stringify(error)}`);
      throw new NotFoundException(error);
    }
  }

  async validateSession(sessionId: string): Promise<object> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true }
    });
    return session;
  }

  /**
   *
   * @param id
   * @returns User profile data
   */
  async getUserById(id: string): Promise<IUsersProfile> {
    const queryOptions: UserQueryOptions = {
      id
    };

    return this.findUser(queryOptions);
  }

  /**
   *
   * @param id
   * @returns User profile data
   */
  async getUserPublicProfile(username: string): Promise<IUsersProfile> {
    const queryOptions: UserQueryOptions = {
      username
    };

    return this.findUserForPublicProfile(queryOptions);
  }

  /**
   *
   * @body updateUserProfile
   * @returns Update user profile data
   */
  async updateUserProfile(updateUserProfile: UpdateUserProfile): Promise<user> {
    try {
      const userdetails = await this.prisma.user.update({
        where: {
          id: String(updateUserProfile.id)
        },
        data: {
          profileImg: updateUserProfile.profileImg,
          firstName: updateUserProfile.firstName,
          lastName: updateUserProfile.lastName,
          publicProfile: updateUserProfile?.isPublic
        }
      });
      return userdetails;
    } catch (error) {
      this.logger.error(`error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  /**
   *
   * @param id
   * @returns User data
   */
  async getUserBySupabaseId(id: string): Promise<object> {
    try {
      return this.prisma.user.findFirst({
        where: {
          supabaseUserId: id
        },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          isEmailVerified: true,
          clientId: true,
          clientSecret: true,
          supabaseUserId: true,
          userOrgRoles: {
            include: {
              orgRole: true,
              organisation: {
                include: {
                  // eslint-disable-next-line camelcase
                  org_agents: true
                }
              }
            }
          }
        }
      });
    } catch (error) {
      this.logger.error(`Not Found: ${JSON.stringify(error)}`);
      throw new NotFoundException(error);
    }
  }

  /**
   *
   * @param id
   * @returns
   */
  async getUserByKeycloakId(id: string): Promise<object> {
    try {
      return this.prisma.user.findFirstOrThrow({
        where: {
          keycloakUserId: id
        },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          isEmailVerified: true,
          clientId: true,
          clientSecret: true,
          supabaseUserId: true,
          keycloakUserId: true,
          userOrgRoles: {
            include: {
              orgRole: true,
              organisation: {
                include: {
                  // eslint-disable-next-line camelcase
                  org_agents: true
                }
              }
            }
          },
          // Holder marker for JwtStrategy -- written at signup only for isHolder accounts. Narrowed
          // to the enum: it is all JwtStrategy consumes, and this row crosses NATS on every
          // authenticated request.
          user_role_mapping: {
            select: {
              user_role: {
                select: {
                  role: true
                }
              }
            }
          }
        }
      });
    } catch (error) {
      this.logger.error(`error in getUserByKeycloakId: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<object> {
    const queryOptions: UserQueryOptions = {
      email
    };
    return this.findUser(queryOptions);
  }

  async findUser(queryOptions: UserQueryOptions): Promise<IUsersProfile> {
    return this.prisma.user.findFirst({
      where: {
        OR: [
          {
            id: queryOptions.id
          },
          {
            email: queryOptions.email
          }
        ]
      },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        profileImg: true,
        publicProfile: true,
        supabaseUserId: true,
        keycloakUserId: true,
        isEmailVerified: true,
        userOrgRoles: {
          select: {
            id: true,
            userId: true,
            orgRoleId: true,
            orgId: true,
            orgRole: {
              select: {
                id: true,
                name: true,
                description: true
              }
            },
            organisation: {
              select: {
                id: true,
                name: true,
                description: true,
                orgSlug: true,
                logoUrl: true,
                website: true,
                publicProfile: true,
                countryId: true,
                stateId: true,
                cityId: true
              }
            }
          }
        }
      }
    });
  }

  async findUserForPublicProfile(queryOptions: UserQueryOptions): Promise<IUsersProfile> {
    return this.prisma.user.findFirst({
      where: {
        publicProfile: true,
        OR: [
          {
            id: String(queryOptions.id)
          },
          {
            email: queryOptions.email
          },
          {
            username: queryOptions.username
          }
        ]
      },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        isEmailVerified: true,
        publicProfile: true,
        userOrgRoles: {
          select: {
            id: true,
            userId: true,
            orgRoleId: true,
            orgId: true,
            orgRole: {
              select: {
                id: true,
                name: true,
                description: true
              }
            },
            organisation: {
              select: {
                id: true,
                name: true,
                description: true,
                orgSlug: true,
                logoUrl: true,
                website: true,
                publicProfile: true,
                countryId: true,
                stateId: true,
                cityId: true
              }
            }
          }
        }
      }
    });
  }

  /**
   *
   * @param tenantDetails
   * @returns Updates organization details
   */
  // eslint-disable-next-line camelcase
  async updateUserDetails(id: string, keycloakId: string): Promise<user> {
    try {
      const updateUserDetails = await this.prisma.user.update({
        where: {
          id
        },
        data: {
          isEmailVerified: true,
          keycloakUserId: keycloakId
        }
      });
      return updateUserDetails;
    } catch (error) {
      this.logger.error(`Error in update isEmailVerified: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @param userInfo
   * @returns Updates user details
   */
  // eslint-disable-next-line camelcase
  async updateUserInfo(email: string, userInfo: IUserInformation): Promise<user> {
    try {
      const updateUserDetails = await this.prisma.user.update({
        where: {
          email
        },
        data: {
          firstName: userInfo.firstName,
          lastName: userInfo.lastName
        }
      });
      return updateUserDetails;
    } catch (error) {
      this.logger.error(`Error in update isEmailVerified: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @param queryOptions
   * @param filterOptions
   * @returns users list
   */
  async findOrgUsers(
    queryOptions: object,
    pageNumber: number,
    pageSize: number,
    filterOptions?: object
  ): Promise<IOrgUsers> {
    const result = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: {
          ...queryOptions // Spread the dynamic condition object
        },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          isEmailVerified: true,
          userOrgRoles: {
            where: {
              ...filterOptions
              // Additional filtering conditions if needed
            },
            select: {
              id: true,
              orgId: true,
              orgRoleId: true,
              orgRole: {
                select: {
                  id: true,
                  name: true,
                  description: true
                }
              },
              organisation: {
                select: {
                  id: true,
                  name: true,
                  description: true,
                  orgSlug: true,
                  logoUrl: true,
                  // eslint-disable-next-line camelcase
                  org_agents: {
                    select: {
                      id: true,
                      orgDid: true,
                      walletName: true,
                      agentSpinUpStatus: true,
                      agentsTypeId: true,
                      createDateTime: true,
                      orgAgentTypeId: true
                    }
                  }
                }
              }
            }
          }
        },
        take: pageSize,
        skip: (pageNumber - 1) * pageSize,
        orderBy: {
          createDateTime: 'desc'
        }
      }),
      this.prisma.user.count({
        where: {
          ...queryOptions
        }
      })
    ]);

    const users = result[0];
    const totalCount = result[1];
    const totalPages = Math.ceil(totalCount / pageSize);

    return { totalPages, users };
  }

  /**
   *
   * @param queryOptions
   * @param filterOptions
   * @returns users list
   */
  async findUsers(queryOptions: object, pageNumber: number, pageSize: number): Promise<object> {
    const result = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: {
          ...queryOptions, // Spread the dynamic condition object
          publicProfile: true
        },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          profileImg: true,
          isEmailVerified: true,
          clientId: false,
          clientSecret: false,
          supabaseUserId: false
        },
        take: pageSize,
        skip: (pageNumber - 1) * pageSize,
        orderBy: {
          createDateTime: 'desc'
        }
      }),
      this.prisma.user.count({
        where: {
          ...queryOptions
        }
      })
    ]);

    const users = result[0];
    const totalCount = result[1];
    const totalPages = Math.ceil(totalCount / pageSize);

    return { totalPages, users };
  }

  async getAttributesBySchemaId(shareUserCertificate: IShareUserCertificate): Promise<schema> {
    try {
      const getAttributes = await this.prisma.schema.findFirst({
        where: {
          schemaLedgerId: shareUserCertificate.schemaId
        }
      });
      return getAttributes;
    } catch (error) {
      this.logger.error(`checkSchemaExist:${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  async checkUniqueUserExist(email: string): Promise<user> {
    try {
      return this.prisma.user.findUnique({
        where: {
          email
        }
      });
    } catch (error) {
      this.logger.error(`checkUserExist: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  async verifyUser(email: string): Promise<IVerifyUserEmail> {
    try {
      const updateUserDetails = await this.prisma.user.update({
        where: {
          email
        },
        data: {
          isEmailVerified: true
        }
      });
      return updateUserDetails;
    } catch (error) {
      this.logger.error(`Error in update isEmailVerified: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @param userInfo
   * @returns Updates user credentials
   */
  // eslint-disable-next-line camelcase
  async addUserPassword(email: string, userInfo: string): Promise<user> {
    try {
      const updateUserDetails = await this.prisma.user.update({
        where: {
          email
        },
        data: {
          password: userInfo
        }
      });
      return updateUserDetails;
    } catch (error) {
      this.logger.error(`Error in update isEmailVerified: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @param userId
   * @param token
   * @param expireTime
   * @returns token details
   */
  async createTokenForResetPassword(userId: string, token: string, expireTime: Date): Promise<token> {
    try {
      const createResetPasswordToken = await this.prisma.token.create({
        data: {
          token,
          userId,
          expiresAt: expireTime
        }
      });
      return createResetPasswordToken;
    } catch (error) {
      this.logger.error(`Error in createTokenForResetPassword: ${error.message} `);
      throw error;
    }
  }

  async createSession(tokenDetails: ISession): Promise<session> {
    try {
      const { sessionToken, userId, expires, refreshToken, accountId, sessionType, expiresAt } = tokenDetails;
      const sessionResponse = await this.prisma.session.create({
        data: {
          id: tokenDetails.id,
          sessionToken,
          expires,
          userId,
          refreshToken,
          accountId,
          sessionType,
          expiresAt,
          ...(tokenDetails.clientInfo ? { clientInfo: tokenDetails.clientInfo } : { clientInfo: { clientToken: true } })
        }
      });
      return sessionResponse;
    } catch (error) {
      this.logger.error(`Error in creating session: ${error.message} `);
      throw error;
    }
  }

  async fetchUserSessions(userId: string): Promise<IRestrictedUserSession[]> {
    try {
      const userSessionCount = await this.prisma.session.findMany({
        where: {
          userId
        },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          createdAt: true,
          clientInfo: true,
          sessionType: true
        }
      });
      return userSessionCount;
    } catch (error) {
      this.logger.error(`Error in getting user session details: ${error.message} `);
      throw error;
    }
  }

  //this function is to fetch all session details for a user including token details without any restriction
  async fetchUserSessionDetails(userId: string): Promise<ISession[]> {
    try {
      const userSessionCount = await this.prisma.session.findMany({
        where: {
          userId
        }
      });
      return userSessionCount;
    } catch (error) {
      this.logger.error(`Error in getting user session details: ${error.message} `);
      throw error;
    }
  }

  async checkAccountDetails(userId: string): Promise<account> {
    try {
      const accountDetails = await this.prisma.account.findUnique({
        where: {
          userId
        }
      });
      return accountDetails;
    } catch (error) {
      this.logger.error(`Error in getting account details: ${error.message} `);
      throw error;
    }
  }

  async addAccountDetails(accountDetails: ISession): Promise<account> {
    try {
      const userAccountDetails = await this.prisma.account.create({
        data: {
          userId: accountDetails.userId,
          provider: ProviderType.KEYCLOAK,
          providerAccountId: accountDetails.keycloakUserId,
          tokenType: accountDetails.type
        }
      });
      return userAccountDetails;
    } catch (error) {
      this.logger.error(`Error in creating account: ${error.message}`);
      throw error;
    }
  }

  /**
   *
   * @param userId
   * @param token
   * @returns reset password token details
   */
  async getResetPasswordTokenDetails(userId: string, token: string): Promise<token> {
    try {
      const tokenDetails = await this.prisma.token.findUnique({
        where: {
          userId,
          token
        }
      });
      return tokenDetails;
    } catch (error) {
      this.logger.error(`Error in getResetPasswordTokenDetails: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @param id
   * @returns token delete records
   */
  async deleteResetPasswordToken(id: string): Promise<token> {
    try {
      const tokenDeleteDetails = await this.prisma.token.delete({
        where: {
          id
        }
      });
      return tokenDeleteDetails;
    } catch (error) {
      this.logger.error(`Error in deleteResetPasswordToken: ${error.message} `);
      throw error;
    }
  }

  /**
   *
   * @body updatePlatformSettings
   * @returns Update platform settings
   */
  async updatePlatformSettings(updatePlatformSettings: PlatformSettings): Promise<object> {
    try {
      const getPlatformDetails = await this.prisma.platform_config.findFirst();
      const platformDetails = await this.prisma.platform_config.update({
        where: {
          id: getPlatformDetails.id
        },
        data: {
          externalIp: updatePlatformSettings.externalIp,
          inboundEndpoint: updatePlatformSettings.inboundEndpoint,
          sgApiKey: updatePlatformSettings.sgApiKey,
          emailFrom: updatePlatformSettings.emailFrom,
          apiEndpoint: updatePlatformSettings.apiEndPoint
        }
      });

      return platformDetails;
    } catch (error) {
      this.logger.error(`error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  async getPlatformSettings(): Promise<object> {
    try {
      const getPlatformSettingsList = await this.prisma.platform_config.findMany();
      return getPlatformSettingsList;
    } catch (error) {
      this.logger.error(`error in getPlatformSettings: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error);
    }
  }

  async updateOrgDeletedActivity(
    orgId: string,
    userId: string,
    deletedBy: string,
    recordType: RecordType,
    userEmail: string,
    txnMetadata: object
  ): Promise<IUserDeletedActivity> {
    try {
      const orgDeletedActivity = await this.prisma.user_org_delete_activity.create({
        data: {
          orgId,
          userEmail,
          deletedBy,
          recordType,
          txnMetadata,
          userId
        }
      });
      return orgDeletedActivity;
    } catch (error) {
      this.logger.error(`Error in updateOrgDeletedActivity: ${error} `);
      throw error;
    }
  }

  async getUserDetailsByUserId(userId: string): Promise<{
    email: string;
  }> {
    try {
      const getUserDetails = await this.prisma.user.findUnique({
        where: {
          id: userId
        },
        select: {
          email: true
        }
      });
      return getUserDetails;
    } catch (error) {
      this.logger.error(`Error in getting user details: ${error} `);
      throw error;
    }
  }

  async getUserKeycloak(userEmails: string[]): Promise<UserKeycloakId[]> {
    try {
      const users = await this.prisma.user.findMany({
        where: {
          email: {
            in: userEmails
          }
        },
        select: {
          email: true,
          keycloakUserId: true,
          id: true
        }
      });

      // Create a map for quick lookup of keycloakUserId, id, and email by email
      const userMap = new Map(
        users.map((user) => [user.email, { id: user.id, keycloakUserId: user.keycloakUserId, email: user.email }])
      );

      // Collect the keycloakUserId, id, and email in the order of input emails
      const result = userEmails.map((email) => {
        const user = userMap.get(email);
        return { id: user?.id || null, keycloakUserId: user?.keycloakUserId || null, email };
      });

      return result;
    } catch (error) {
      this.logger.error(`Error in getUserKeycloak: ${error}`);
      throw error;
    }
  }

  async storeUserRole(userId: string, userRoleId: string): Promise<UserRoleMapping> {
    try {
      const userRoleMapping = await this.prisma.user_role_mapping.create({
        data: {
          userId,
          userRoleId
        }
      });
      return userRoleMapping;
    } catch (error) {
      this.logger.error(`Error in storeUserRole: ${error.message} `);
      throw error;
    }
  }

  async getUserRole(role: UserRole): Promise<UserRoleDetails> {
    try {
      const getUserRole = await this.prisma.user_role.findFirstOrThrow({
        where: {
          role
        }
      });
      return getUserRole;
    } catch (error) {
      this.logger.error(`Error in getUserRole: ${error.message} `);
      throw error;
    }
  }

  // eslint-disable-next-line camelcase
  async handleGetUserOrganizations(userId: string): Promise<user_org_roles[]> {
    try {
      const getUserOrgs = await this.prisma.user_org_roles.findMany({
        where: {
          userId
        }
      });

      return getUserOrgs;
    } catch (error) {
      this.logger.error(`Error in handleGetUserOrganizations: ${error.message}`);
      throw error;
    }
  }

  async destroySession(sessions: string[]): Promise<Prisma.BatchPayload> {
    try {
      const userSessions = await this.prisma.session.deleteMany({
        where: {
          id: {
            in: sessions
          }
        }
      });

      return userSessions;
    } catch (error) {
      this.logger.error(`Error in logging out user: ${error.message}`);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<session> {
    try {
      const userSession = await this.prisma.session.delete({
        where: {
          id: sessionId
        }
      });
      return userSession;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && 'P2025' === error.code) {
        this.logger.warn(`Session not found for deletion: ${sessionId}`);
        throw new NotFoundException('Record to be deleted not found');
      } else {
        this.logger.error(`Error in logging out user: ${error.message}`);
        throw error;
      }
    }
  }

  async deleteSessionBySessionId(sessionId: string, userId: string): Promise<{ message: string }> {
    try {
      await this.prisma.session.delete({
        where: { id: sessionId, userId }
      });

      return { message: 'Session deleted successfully' };
    } catch (error) {
      if ('P2025' === error.code) {
        throw new RpcException(new NotFoundException(`Session not found for userId: ${userId}`));
      }
      this.logger.error(`Error in Deleting Session: ${error.message}`);
      throw error;
    }
  }

  async fetchSessionByRefreshToken(refreshToken: string): Promise<session> {
    try {
      const sessionDetails = await this.prisma.session.findFirst({
        where: {
          refreshToken
        }
      });
      return sessionDetails;
    } catch (error) {
      this.logger.error(`Error in fetching session details::${error.message}`);
      throw error;
    }
  }

  async deleteInactiveSessions(userId: string): Promise<Prisma.BatchPayload> {
    try {
      const response = await this.prisma.session.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          },
          userId
        }
      });
      this.logger.debug('Deleted inactive sessions::', response);
      return response;
    } catch (error) {
      this.logger.error(`Error in deleting the in active sessions::${error.message}`);
      throw error;
    }
  }

  async updateSessionToken(id: string, tokenData: ITokenData): Promise<session> {
    if (!id || !tokenData) {
      throw new BadRequestException(`Missing id or tokenData for session details update`);
    }
    try {
      const sessionResponse = await this.prisma.session.update({
        where: {
          id
        },
        data: tokenData
      });
      return sessionResponse;
    } catch (error) {
      this.logger.error(`Error in creating session: ${error.message} `);
      if (error instanceof Prisma.PrismaClientKnownRequestError && 'P2025' === error.code) {
        this.logger.warn(`Session not found for update: ${id}`);
        throw new NotFoundException('Session not found');
      }
      throw error;
    }
  }
}
