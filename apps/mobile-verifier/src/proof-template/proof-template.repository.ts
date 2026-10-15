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

  // Ids from `roleIds` that are roles of `orgId` — used to refuse role ids of another organization.
  async getOrgRoleIds(orgId: string, roleIds: string[]): Promise<string[]> {
    const roles = await this.prismaService.mobile_verifier_role.findMany({
      where: { orgId, id: { in: roleIds } },
      select: { id: true }
    });
    return roles.map((role) => role.id);
  }

  // A role id that does not exist surfaces as P2025 or, for the mapping insert, as a foreign key
  // violation (P2003) — both mean "the given role does not exist".
  private isMissingRoleError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (PrismaError.RecordDoesNotExist === error.code || PrismaError.ForeignKeyConstraintFailed === error.code)
    );
  }

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
      if (this.isMissingRoleError(error)) {
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
        // updateMany with nothing to set reports 0 even for an existing row, so a roles-only
        // update has to check that the template exists (in this org) another way.
        const hasFieldUpdates = Object.values(data).some((value) => undefined !== value);
        const count = hasFieldUpdates
          ? (await transactionContext.mobile_verifier_proof_template.updateMany({ where: { id, orgId }, data })).count
          : await transactionContext.mobile_verifier_proof_template.count({ where: { id, orgId } });

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
      if (this.isMissingRoleError(error)) {
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
