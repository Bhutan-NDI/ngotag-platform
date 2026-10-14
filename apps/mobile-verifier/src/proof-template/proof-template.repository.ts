import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  mobile_verifier_proof_template as ProofTemplate,
  mobile_verifier_role as VerifierRole,
  mobile_verifier_role_to_proof_template as VerifierRoleToProofTemplate
} from '@prisma/client';
import { PrismaService } from '@credebl/prisma-service';
import { PrismaError } from '../common/constants';

@Injectable()
export class ProofTemplateRepo {
  constructor(private readonly prismaService: PrismaService) {}

  async createProofTemplate(
    proofTemplateDto: Prisma.mobile_verifier_proof_templateCreateInput
  ): Promise<ProofTemplate> {
    return this.prismaService.mobile_verifier_proof_template.create({ data: proofTemplateDto });
  }

  async getRoleProofTemplates(params: {
    skip?: number;
    take?: number;
    where?: Prisma.mobile_verifier_role_to_proof_templateWhereInput;
  }): Promise<[number, { proofTemplate: ProofTemplate }[]]> {
    const { skip, take, where } = params;
    return this.prismaService.$transaction([
      this.prismaService.mobile_verifier_role_to_proof_template.count({ where: { ...where } }),
      this.prismaService.mobile_verifier_role_to_proof_template.findMany({
        skip,
        take,
        where: { ...where },
        select: { proofTemplate: true }
      })
    ]);
  }

  async createProofTemplateAndVerifierRoleMapping(
    proofTemplateDto: Prisma.mobile_verifier_proof_templateCreateInput,
    verifierRoleIds: string[]
  ): Promise<{
    proofTemplate: ProofTemplate;
    mappedVerifierRoleAndProofTemplate: VerifierRoleToProofTemplate[];
  }> {
    try {
      const mappedRoleAndTemplateIDs: VerifierRoleToProofTemplate[] = [];
      return await this.prismaService.$transaction(async (transactionContext) => {
        const createdRecord = await transactionContext.mobile_verifier_proof_template.create({
          data: proofTemplateDto
        });
        const createdRecordId = createdRecord.id;

        for (const roleId of verifierRoleIds) {
          const mappedRecord = await transactionContext.mobile_verifier_role_to_proof_template.create({
            data: {
              verifierRoleId: roleId,
              proofTemplateId: createdRecordId
            }
          });
          mappedRoleAndTemplateIDs.push(mappedRecord);
        }

        return { proofTemplate: createdRecord, mappedVerifierRoleAndProofTemplate: mappedRoleAndTemplateIDs };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error?.code === PrismaError.RecordDoesNotExist) {
        throw new HttpException('The given role/roles does not exist', HttpStatus.BAD_REQUEST);
      }
      throw error;
    }
  }

  // Scoped by orgId so a template can never be updated across organizations.
  // When verifierRoleIds is provided, the existing mappings are replaced wholesale.
  async updateProofTemplate(
    id: string,
    orgId: string,
    data: Prisma.mobile_verifier_proof_templateUpdateInput,
    verifierRoleIds?: string[]
  ): Promise<number> {
    try {
      return await this.prismaService.$transaction(async (transactionContext) => {
        const { count } = await transactionContext.mobile_verifier_proof_template.updateMany({
          where: { id, orgId },
          data
        });

        if (0 === count) {
          return 0;
        }

        if (verifierRoleIds) {
          await transactionContext.mobile_verifier_role_to_proof_template.deleteMany({
            where: { proofTemplateId: id }
          });

          for (const roleId of verifierRoleIds) {
            await transactionContext.mobile_verifier_role_to_proof_template.create({
              data: { verifierRoleId: roleId, proofTemplateId: id }
            });
          }
        }

        return count;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error?.code === PrismaError.RecordDoesNotExist) {
        throw new HttpException('The given role/roles does not exist', HttpStatus.BAD_REQUEST);
      }
      throw error;
    }
  }

  async getProofTemplate(where: Prisma.mobile_verifier_proof_templateWhereInput): Promise<
    ProofTemplate & {
      verifierRoleToProofTemplates: (VerifierRoleToProofTemplate & {
        verifierRole: VerifierRole;
      })[];
    }
  > {
    return this.prismaService.mobile_verifier_proof_template.findFirst({
      where,
      include: {
        verifierRoleToProofTemplates: {
          include: { verifierRole: true }
        }
      }
    });
  }

  async getProofTemplates(params: {
    skip?: number;
    take?: number;
    where?: Prisma.mobile_verifier_proof_templateWhereInput;
    verifierRoleToProofTemplatesWhere?: Prisma.mobile_verifier_role_to_proof_templateWhereInput;
  }): Promise<[number, ProofTemplate[]]> {
    const { skip, take, where, verifierRoleToProofTemplatesWhere } = params;
    return this.prismaService.$transaction([
      this.prismaService.mobile_verifier_proof_template.count({ where: { ...where } }),
      this.prismaService.mobile_verifier_proof_template.findMany({
        skip,
        take,
        where: { ...where },
        include: {
          verifierRoleToProofTemplates: {
            where: verifierRoleToProofTemplatesWhere,
            include: { verifierRole: true }
          }
        }
      })
    ]);
  }
}
