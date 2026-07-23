import { AwsModule, AwsService } from '@credebl/aws';
import { AzureStorageModule, AzureStorageService } from '@credebl/azure-storage';
import { Module } from '@nestjs/common';

import { STORAGE_SERVICE, StorageType } from './storage.constants';

/**
 * Selects the storage provider from STORAGE_TYPE ('aws' | 'azure'), defaulting to
 * 'aws' when unset. Resolved at instantiation time via a factory (not at module-load),
 * reusing the AwsService/AzureStorageService instances from the imported modules.
 * Consumers import StorageModule and inject the STORAGE_SERVICE token (typed as StorageService).
 */
@Module({
  imports: [AwsModule, AzureStorageModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useFactory: (aws: AwsService, azure: AzureStorageService): AwsService | AzureStorageService => {
        const storageType = (process.env.STORAGE_TYPE ?? StorageType.AWS).toLowerCase();
        return storageType === StorageType.AZURE ? azure : aws;
      },
      inject: [AwsService, AzureStorageService]
    }
  ],
  exports: [STORAGE_SERVICE]
})
export class StorageModule {}
