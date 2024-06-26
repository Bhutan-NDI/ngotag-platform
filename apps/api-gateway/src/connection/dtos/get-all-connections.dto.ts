import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';
import { SortValue } from '../../enum';
import { trim } from '@credebl/common/cast.helper';
import { SortFields } from 'apps/connection/src/enum/connection.enum';

export class GetAllConnectionsDto {
  @ApiProperty({ required: false, example: '1' })
  @IsOptional()
  pageNumber: number = 1;

  @ApiProperty({ required: false, example: '10' })
  @IsOptional()
  pageSize: number = 10;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @Type(() => String)
  searchByText: string = '';

  @ApiProperty({
    required: false
  })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsEnum(SortFields)
  sortField: string = SortFields.CREATED_DATE_TIME;

  @ApiProperty({
    enum: [SortValue.DESC, SortValue.ASC],
    required: false
  })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsEnum(SortValue)
  sortBy: string = SortValue.DESC;
}

export class GetAllAgentConnectionsDto {
  @ApiProperty({ required: false, example: 'e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsOptional()
  outOfBandId: string = '';

  @ApiProperty({ required: false, example: 'Test' })
  @IsOptional()
  alias: string = '';

  @ApiProperty({ required: false, example: 'did:example:e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsOptional()
  myDid: string = '';

  @ApiProperty({ required: false, example: 'did:example:e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsOptional()
  theirDid: string = '';

  @ApiProperty({ required: false, example: 'Bob' })
  @IsOptional()
  theirLabel: string = '';
}
