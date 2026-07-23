import { AwsModule, AwsService } from '@credebl/aws';
import { AzureStorageModule, AzureStorageService } from '@credebl/azure-storage';
import { Module } from '@nestjs/common';

import { STORAGE_SERVICE, StorageType } from './storage.constants';

/**
 * Selects the storage provider from STORAGE_TYPE ('aws' | 'azure'), defaulting to
 * 'aws' when unset. Consumers import StorageModule and inject the STORAGE_SERVICE
 * token (typed as StorageService).
 */
const resolveStorageProvider = (): typeof AwsService | typeof AzureStorageService => {
  const storageType = (process.env.STORAGE_TYPE ?? StorageType.AWS).toLowerCase();
  return storageType === StorageType.AZURE ? AzureStorageService : AwsService;
};

@Module({
  imports: [AwsModule, AzureStorageModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useClass: resolveStorageProvider()
    }
  ],
  exports: [STORAGE_SERVICE]
})
export class StorageModule {}
