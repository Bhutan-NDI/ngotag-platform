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
import { getNextPrevPages, getSkipTake } from '../common/functions';
import { PrismaError } from '../common/constants';
import { assertRole } from '../common/keycloak-roles.util';
import { OrgRoles } from 'libs/org-roles/enums';

@Injectable()
export class ProofTemplateService {
  constructor(private readonly proofTemplateRepo: ProofTemplateRepo) {}

  async createProofTemplate(
    proofTemplateDto: ProofTemplateDto,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_PROOF_TEMPLATE);

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
            payload: JSON.stringify(payload),
            createdByOrgId: loginOrgId
          },
          verifierRoleIds
        );
      } else {
        proofTemplate = await this.proofTemplateRepo.createProofTemplate({
          ...proofDetails,
          orgId: loginOrgId,
          payload: JSON.stringify(payload),
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

    const { payload, verifierRoleIds, ...proofDetails } = proofTemplateDto;

    try {
      const updatedCount = await this.proofTemplateRepo.updateProofTemplate(
        id,
        loginOrgId,
        {
          ...proofDetails,
          ...(payload ? { payload: JSON.stringify(payload) } : {})
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
        payload: JSON.parse(ele.proofTemplate.payload as string)
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
      search?: string;
      page?: number;
      pageSize?: number;
    },
    loginOrgId: string
  ): Promise<ResponseType> {
    const { page = 1, pageSize = 10, id, templateId, search } = params;
    const orgAccessWhere: Prisma.mobile_verifier_proof_templateWhereInput = { orgId: loginOrgId };

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
        data: proofTemplate
      };
    }

    const { skip, take } = getSkipTake(Number(page), Number(pageSize));
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
      data: proofTemplates,
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
