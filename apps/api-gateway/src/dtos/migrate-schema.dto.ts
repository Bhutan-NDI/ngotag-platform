import { Equals, IsNotEmpty, IsString } from 'class-validator';

import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { trim } from '@credebl/common/cast.helper';
import { JSONSchemaType } from '@credebl/enum/enum';

export class MigrateW3CSchemaDto {
    
    @ApiProperty({
      description: 'The identifier of the schema',
      example: '12345678-1234-5678-1234-567812345678' 
    })
    @IsString()
    @Transform(({ value }) => trim(value))
    @IsNotEmpty({ message: 'schemaId is required' })
    schemaId: string;

    @ApiProperty({
      description: 'The target schema type (only Ethereum supported)',
      enum: [JSONSchemaType.ETHEREUM_W3C],
      example: JSONSchemaType.ETHEREUM_W3C 
    })
    @Equals(JSONSchemaType.ETHEREUM_W3C, {
      message: 'Only Ethereum schema type is supported as target for now'
    })
    @IsNotEmpty({ message: 'targetSchemaType is required' })
    targetSchemaType: JSONSchemaType;
}