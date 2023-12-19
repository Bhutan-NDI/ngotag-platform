import { Controller, Logger, Post, Body, HttpStatus, UseGuards, Get, Query, BadRequestException, Res, UseFilters, Param } from '@nestjs/common';
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable camelcase */
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse, ApiQuery } from '@nestjs/swagger';
import { SchemaService } from './schema.service';
import { AuthGuard } from '@nestjs/passport';
import { ApiResponseDto } from '../dtos/apiResponse.dto';
import { UnauthorizedErrorDto } from '../dtos/unauthorized-error.dto';
import { ForbiddenErrorDto } from '../dtos/forbidden-error.dto';
import IResponseType from '@credebl/common/interfaces/response.interface';
import { Response } from 'express';
import { User } from '../authz/decorators/user.decorator';
import { ICredDeffSchemaSearchInterface, ISchemaSearchInterface } from '../interfaces/ISchemaSearch.interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import { GetAllSchemaDto, GetCredentialDefinitionBySchemaIdDto } from './dtos/get-all-schema.dto';
import { OrgRoles } from 'libs/org-roles/enums';
import { Roles } from '../authz/decorators/roles.decorator';
import { IUserRequestInterface } from './interfaces';
import { OrgRolesGuard } from '../authz/guards/org-roles.guard';
import { CreateSchemaDto } from '../dtos/create-schema.dto';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';

@UseFilters(CustomExceptionFilter)
@Controller('orgs')
@ApiTags('schemas')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ status: 401, description: 'Unauthorized', type: UnauthorizedErrorDto })
@ApiForbiddenResponse({ status: 403, description: 'Forbidden', type: ForbiddenErrorDto })
export class SchemaController {
  constructor(private readonly appService: SchemaService
  ) { }
  private readonly logger = new Logger('SchemaController');

  @Get('/:orgId/schemas/:schemaId')
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiOperation({
    summary: 'Get schema information from the ledger using its schema ID.',
    description: 'Get schema information from the ledger using its schema ID.'
  })
  @ApiResponse({ status: 200, description: 'Success', type: ApiResponseDto })
  async getSchemaById(
    @Res() res: Response,
    @Param('orgId') orgId: string,
    @Param('schemaId') schemaId: string
  ): Promise<object> {

    if (!schemaId) {
      throw new BadRequestException(ResponseMessages.schema.error.invalidSchemaId);
    }
    const schemaDetails = await this.appService.getSchemaById(schemaId, orgId);
    const finalResponse: IResponseType = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.schema.success.fetch,
      data: schemaDetails.response
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/:orgId/schemas/:schemaId/cred-defs')
  @ApiOperation({
    summary: 'Get credential definition list by schema Id',
    description: 'Get credential definition list by schema Id'
  })
  @ApiResponse({ status: 200, description: 'Success', type: ApiResponseDto })
  @ApiQuery({
    name: 'pageNumber',
    type: Number,
    required: false
  })
  @ApiQuery({
    name: 'pageSize',
    type: Number,
    required: false
  })
  @ApiQuery({
    name: 'sorting',
    type: String,
    required: false
  })
  @ApiQuery({
    name: 'sortByValue',
    type: String,
    required: false
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async getcredDeffListBySchemaId(
    @Param('orgId') orgId: string,
    @Param('schemaId') schemaId: string,
    @Query() GetCredentialDefinitionBySchemaIdDto: GetCredentialDefinitionBySchemaIdDto,
    @Res() res: Response,
    @User() user: IUserRequestInterface): Promise<object> {

    if (!schemaId) {
      throw new BadRequestException(ResponseMessages.schema.error.invalidSchemaId);
    }

    const credentialDefinitionList = await this.appService.getcredDeffListBySchemaId(schemaId, GetCredentialDefinitionBySchemaIdDto, user, orgId);
    const finalResponse: IResponseType = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.schema.success.fetch,
      data: credentialDefinitionList.response
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/:orgId/schemas')
  @ApiOperation({
    summary: 'Get all schemas by org id.',
    description: 'Get all schemas by org id.'
  })
  @ApiQuery({
    name: 'pageNumber',
    type: Number,
    required: false
  })
  @ApiQuery({
    name: 'searchByText',
    type: String,
    required: false
  })
  @ApiQuery({
    name: 'pageSize',
    type: Number,
    required: false
  })
  @ApiQuery({
    name: 'sorting',
    type: String,
    required: false
  })
  @ApiQuery({
    name: 'sortByValue',
    type: String,
    required: false
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiResponse({ status: 200, description: 'Success', type: ApiResponseDto })
  async getSchemas(
    @Query() getAllSchemaDto: GetAllSchemaDto,
    @Param('orgId') orgId: string,
    @Res() res: Response,
    @User() user: IUserRequestInterface
  ): Promise<object> {

    const { pageSize, searchByText, pageNumber, sorting, sortByValue } = getAllSchemaDto;
    const schemaSearchCriteria: ISchemaSearchInterface = {
      pageNumber,
      searchByText,
      pageSize,
      sorting,
      sortByValue
    };
    const schemasResponse = await this.appService.getSchemas(schemaSearchCriteria, user, orgId);

    const finalResponse: IResponseType = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.schema.success.fetch,
      data: schemasResponse.response
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/:orgId/schemas')
  @ApiOperation({
    summary: 'Create and sends a schema to the ledger.',
    description: 'Create and sends a schema to the ledger.'
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiResponse({ status: 201, description: 'Success', type: ApiResponseDto })
  async createSchema(@Res() res: Response, @Body() schema: CreateSchemaDto, @Param('orgId') orgId: string, @User() user: IUserRequestInterface): Promise<object> {

    schema.orgId = orgId;
    const schemaCreate = await this.appService.createSchema(schema, user, schema.orgId);

    const finalResponse: IResponseType = {
      statusCode: HttpStatus.CREATED,
      message: schemaCreate.response
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }
}
