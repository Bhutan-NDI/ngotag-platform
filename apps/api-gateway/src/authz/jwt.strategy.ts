/* eslint-disable camelcase */
import * as dotenv from 'dotenv';
import * as jwt from 'jsonwebtoken';

import { CommonConstants, uuidRegex } from '@credebl/common/common.constant';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { AuthzService } from './authz.service';
import { IOrganization } from '@credebl/common/interfaces/organization.interface';
import { JwtPayload } from './jwt-payload.interface';
import { OrganizationService } from '../organization/organization.service';
import { PassportStrategy } from '@nestjs/passport';
import { ResponseMessages } from '@credebl/common/response-messages';
import { UserRole } from '@credebl/enum/enum';
import { UserService } from '../user/user.service';
import { passportJwtSecret } from 'jwks-rsa';

dotenv.config();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger('Jwt Strategy');

  constructor(
    private readonly usersService: UserService,
    private readonly organizationService: OrganizationService,
    private readonly authzService: AuthzService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: async (request, jwtToken, done) => {
        // Todo: We need to add this logic in seprate jwt gurd to handle the token expiration functionality.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decodedToken: any = jwt.decode(jwtToken);
        if (!decodedToken) {
          return done(new UnauthorizedException(ResponseMessages.user.error.invalidAccessToken), null);
        }

        const audiance = decodedToken.iss.toString();
        const jwtOptions = {
          cache: true,
          rateLimit: true,
          jwksRequestsPerMinute: 5,
          jwksUri: `${audiance}${CommonConstants.URL_KEYCLOAK_JWKS}`
        };
        const secretprovider = passportJwtSecret(jwtOptions);
        let certkey;
        secretprovider(request, jwtToken, async (err, data) => {
          certkey = data;
          done(null, certkey);
        });
      },
      algorithms: ['RS256']
    });
  }

  async validate(payload: JwtPayload): Promise<object> {
    let userDetails = null;

    const sessionId = payload?.sid;
    let sessionDetails = null;
    if (sessionId) {
      try {
        sessionDetails = await this.authzService.checkSession(sessionId);
      } catch (error) {
        this.logger.log('Error in JWT Stratergy while fetching session details', JSON.stringify(error, null, 2));
      }
      if (!sessionDetails) {
        throw new UnauthorizedException(ResponseMessages.user.error.invalidAccessToken);
      }
    }
    if (payload.hasOwnProperty('client_id') && uuidRegex.test(payload['client_id'])) {
      const orgDetails: IOrganization = await this.organizationService.findOrganizationOwner(payload['client_id']);
      this.logger.log('Organization details fetched');
      if (!orgDetails) {
        throw new NotFoundException(ResponseMessages.organisation.error.orgNotFound);
      }

      // eslint-disable-next-line prefer-destructuring
      const userOrgDetails = 0 < orgDetails.userOrgRoles.length && orgDetails.userOrgRoles[0];
      userDetails = userOrgDetails.user;
      userDetails.userOrgRoles = [];
      userDetails.userOrgRoles.push({
        id: userOrgDetails.id,
        userId: userOrgDetails.userId,
        orgRoleId: userOrgDetails.orgRoleId,
        orgId: userOrgDetails.orgId,
        orgRole: userOrgDetails.orgRole
      });

      this.logger.log('User details set');
    } else if (!payload.hasOwnProperty('client_id')) {
      userDetails = await this.usersService.findUserinKeycloak(payload.sub);
    }

    const isServiceToken = payload.hasOwnProperty('client_id') && !uuidRegex.test(payload['client_id'] as string);
    if (!userDetails && !isServiceToken) {
      throw new NotFoundException(ResponseMessages.user.error.notFound);
    }
    // Holder marker. This used to read a Keycloak `userRole` user attribute, which the realm's
    // User Profile doesn't declare and so never stores -- the value was always undefined, which
    // 403'd every holder on UserRoleGuard and silently disabled the inverse check on
    // OrgRolesGuard/UserAccessGuard. user_role_mapping is the platform's own holder-only marker,
    // written at signup for isHolder accounts and already fetched by findUserinKeycloak above.
    const isHolder = userDetails?.user_role_mapping?.some((mapping) => UserRole.HOLDER === mapping?.user_role?.role);
    if (isHolder) {
      userDetails.userRole = CommonConstants.USER_HOLDER_ROLE;
    }

    if (userDetails && payload?.ecosystem_access) {
      userDetails.ecosystem_access = payload.ecosystem_access;
    }

    return {
      ...userDetails,
      ...payload
    };
  }
}
