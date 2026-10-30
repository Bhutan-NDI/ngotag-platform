import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ResponseType } from '../common/response';
import { ProofTemplateRepo } from './proof-template.repository';
import { ProofTemplateDto } from './dto/proof-template.dto';
import { UpdateProofTemplateDto } from './dto/update-proof-template.dto';
import {
  Prisma,
  mobile_verifier_proof_template as ProofTemplate,
  mobile_verifier_role_to_proof_template as VerifierRoleToProofTemplate
} from '@prisma/client';
import { ProofTemplateQueryDto } from './dto/proof-template-query.dto';
import { getNextPrevPages, getSkipTake, parseStoredPayload } from '../common/functions';
import { PrismaError } from '../common/constants';
import { assertRole } from '../common/keycloak-roles.util';
import { OrgRoles } from 'libs/org-roles/enums';

@Injectable()
export class ProofTemplateService {
  constructor(private readonly proofTemplateRepo: ProofTemplateRepo) {}

  // A template may only be mapped to roles of its own organization; otherwise it would show up in
  // another organization's role view.
  private async assertRolesBelongToOrg(roleIds: string[] | undefined, orgId: string): Promise<void> {
    if (!roleIds?.length) {
      return;
    }
    const orgRoleIds = new Set(await this.proofTemplateRepo.getOrgRoleIds(orgId, roleIds));
    if (roleIds.some((roleId) => !orgRoleIds.has(roleId))) {
      throw new HttpException('The given role/roles does not exist', HttpStatus.BAD_REQUEST);
    }
  }

  async createProofTemplate(
    proofTemplateDto: ProofTemplateDto,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_PROOF_TEMPLATE);
    await this.assertRolesBelongToOrg(proofTemplateDto.verifierRoleIds, loginOrgId);

    try {
      const { payload, verifierRoleIds, ...proofDetails } = proofTemplateDto;

      let proofTemplate:
        | { proofTemplate: ProofTemplate; mappedVerifierRoleAndProofTemplate: VerifierRoleToProofTemplate[] }
        | ProofTemplate;
      if (verifierRoleIds) {
        proofTemplate = await this.proofTemplateRepo.createProofTemplateAndVerifierRoleMapping(
          {
            ...proofDetails,
            orgId: loginOrgId,
            payload: payload as unknown as Prisma.InputJsonValue,
            createdByOrgId: loginOrgId
          },
          verifierRoleIds
        );
      } else {
        proofTemplate = await this.proofTemplateRepo.createProofTemplate({
          ...proofDetails,
          orgId: loginOrgId,
          payload: payload as unknown as Prisma.InputJsonValue,
          createdByOrgId: loginOrgId
        });
      }
      return {
        statusCode: HttpStatus.CREATED,
        message: 'Proof Template created successfully',
        data: proofTemplate
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error?.code === PrismaError.UniqueConstraintFailed) {
        throw new HttpException(
          'Please provide unique templateId, the given templateId already exist',
          HttpStatus.BAD_REQUEST
        );
      }
      throw error;
    }
  }

  async updateProofTemplate(
    id: string,
    proofTemplateDto: UpdateProofTemplateDto,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_PROOF_TEMPLATE);
    await this.assertRolesBelongToOrg(proofTemplateDto.verifierRoleIds, loginOrgId);

    const { payload, verifierRoleIds, ...proofDetails } = proofTemplateDto;

    try {
      const updatedCount = await this.proofTemplateRepo.updateProofTemplate(
        id,
        loginOrgId,
        {
          ...proofDetails,
          ...(payload ? { payload: payload as unknown as Prisma.InputJsonValue } : {})
        },
        verifierRoleIds
      );

      if (0 === updatedCount) {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Proof template not found'
        };
      }

      return {
        statusCode: HttpStatus.OK,
        message: 'Proof template updated successfully'
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error?.code === PrismaError.UniqueConstraintFailed) {
        throw new HttpException(
          'Please provide unique templateId, the given templateId already exist',
          HttpStatus.BAD_REQUEST
        );
      }
      throw error;
    }
  }

  async getRoleProofTemplates(params: ProofTemplateQueryDto, loginOrgId: string): Promise<ResponseType> {
    const { page, pageSize, roleId, search } = params;
    const { skip, take } = getSkipTake(page, pageSize);
    const query: {
      skip?: number;
      take?: number;
      where?: Prisma.mobile_verifier_role_to_proof_templateWhereInput;
      search?: string;
    } = {};

    if (search) {
      query.where = {
        verifierRoleId: roleId,
        verifierRole: { orgId: loginOrgId },
        proofTemplate: {
          name: { contains: search }
        }
      };
    } else {
      query.where = {
        verifierRoleId: roleId,
        verifierRole: { orgId: loginOrgId }
      };
    }

    query.skip = skip;
    query.take = take;
    query.search = search;
    const proofTemplates = await this.proofTemplateRepo.getRoleProofTemplates(query);

    const { nextPage, prevPage } = getNextPrevPages(proofTemplates[0], page, pageSize);

    if (0 === proofTemplates[0]) {
      return {
        message: 'Proof templates not found',
        statusCode: HttpStatus.NOT_FOUND
      };
    }
    return {
      statusCode: HttpStatus.OK,
      message: 'Proof templates fetch successfully',
      data: proofTemplates[1].map((ele) => ({
        ...ele.proofTemplate,
        payload: parseStoredPayload(ele.proofTemplate.payload)
      })),
      pagination: {
        total: proofTemplates[0],
        pageSize: proofTemplates[1].length,
        currentPage: page,
        nextPage,
        prevPage
      }
    };
  }

  async getProofTemplates(
    params: {
      id?: string;
      templateId?: string;
      roleId?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
    loginOrgId: string
  ): Promise<ResponseType> {
    const { id, templateId, roleId, search } = params;
    // A repeated ?roleId=a&roleId=b arrives as an array, which Prisma would reject with a 500
    if (undefined !== roleId && 'string' !== typeof roleId) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'roleId must be a single string'
      };
    }
    // `page`/`pageSize` arrive as strings from @Query; keep the pagination math numeric
    const page = Number(params.page) || 1;
    const pageSize = Number(params.pageSize) || 10;
    const orgAccessWhere: Prisma.mobile_verifier_proof_templateWhereInput = {
      orgId: loginOrgId,
      ...(roleId && { verifierRoleToProofTemplates: { some: { verifierRoleId: roleId } } })
    };

    if (id || templateId) {
      const where = id ? { id } : { templateId };
      const proofTemplate = await this.proofTemplateRepo.getProofTemplate({
        ...where,
        ...orgAccessWhere
      });

      if (!proofTemplate) {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Proof template not found'
        };
      }

      return {
        statusCode: HttpStatus.OK,
        message: 'Proof template fetch successfully',
        data: { ...proofTemplate, payload: parseStoredPayload(proofTemplate.payload) }
      };
    }

    const { skip, take } = getSkipTake(page, pageSize);
    const query: {
      skip?: number;
      take?: number;
      where?: Prisma.mobile_verifier_proof_templateWhereInput;
      search?: string;
    } = {};

    query.skip = skip;
    query.take = take;

    if (search) {
      query.where = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      };
    }

    query.where = query.where ? { AND: [query.where, orgAccessWhere] } : orgAccessWhere;

    const proofTemplates = await this.proofTemplateRepo.getProofTemplates(query);

    const { nextPage, prevPage } = getNextPrevPages(proofTemplates[0], page, pageSize);

    return {
      statusCode: HttpStatus.OK,
      message: 'Proof templates fetch successfully',
      data: proofTemplates[1].map((template) => ({ ...template, payload: parseStoredPayload(template.payload) })),
      pagination: {
        total: proofTemplates[0],
        pageSize: proofTemplates[1].length,
        currentPage: page,
        nextPage,
        prevPage
      }
    };
  }
}
