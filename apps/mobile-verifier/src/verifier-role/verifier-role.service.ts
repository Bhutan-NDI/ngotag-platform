import { HttpStatus, Injectable } from '@nestjs/common';
import { VerifierRoleRepository } from './verifier-role.repository';
import { ResponseType } from '../common/response';
import { CreateRole } from './dto/create-role.dto';
import { UpdateRole } from './dto/update-role.dto';
import { getNextPrevPages, getSkipTake } from '../common/functions';
import { Prisma } from '@prisma/client';
import { assertRole } from '../common/keycloak-roles.util';
import { OrgRoles } from 'libs/org-roles/enums';

@Injectable()
export class VerifierRoleService {
  constructor(private readonly verifierRoleRepository: VerifierRoleRepository) {}

  async createVerifierRole(rolePayload: CreateRole, loginOrgId: string, authorization: string): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const roleData: Prisma.mobile_verifier_roleCreateInput = {
      role: rolePayload.role,
      orgId: loginOrgId,
      createdByOrgId: loginOrgId
    };
    const role = await this.verifierRoleRepository.createVerifierRole(roleData);
    return {
      statusCode: HttpStatus.CREATED,
      message: 'Verifier Role created successfully',
      data: role
    };
  }

  async updateVerifierRole(
    id: string,
    rolePayload: UpdateRole,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const updatedCount = await this.verifierRoleRepository.updateVerifierRole(id, loginOrgId, {
      role: rolePayload.role
    });

    if (0 === updatedCount) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Verifier role not found'
      };
    }

    return {
      statusCode: HttpStatus.OK,
      message: 'Verifier role updated successfully'
    };
  }

  async getVerifierRoles(
    params: { id?: string; page?: number; pageSize?: number },
    loginOrgId: string
  ): Promise<ResponseType> {
    const { page = 1, pageSize = 10, id } = params;

    if (id) {
      const verifierRole = await this.verifierRoleRepository.getVerifierRoleByWhere({ id, orgId: loginOrgId });

      if (!verifierRole) {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Verifier role not found'
        };
      }

      return {
        statusCode: HttpStatus.OK,
        message: 'Verifier role fetched successfully',
        data: verifierRole
      };
    }

    const { skip, take } = getSkipTake(Number(page), Number(pageSize));
    const query: {
      skip?: number;
      take?: number;
      where?: Prisma.mobile_verifier_roleWhereInput;
    } = { skip, take, where: { orgId: loginOrgId } };

    const [total, verifierRoles] = await this.verifierRoleRepository.getVerifierRoles(query);

    const { nextPage, prevPage } = getNextPrevPages(total, page, pageSize);

    if (0 === total) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Verifier roles not found'
      };
    }

    return {
      statusCode: HttpStatus.OK,
      message: 'Verifier roles fetched successfully',
      data: verifierRoles,
      pagination: {
        total,
        pageSize: verifierRoles.length,
        currentPage: page,
        nextPage,
        prevPage
      }
    };
  }
}
