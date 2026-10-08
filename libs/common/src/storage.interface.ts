export interface IStorageUploadResult {
  Key: string;
  Location: string;
}

/**
 * Provider-agnostic object/blob storage contract. Both AwsService (S3) and
 * AzureStorageService implement this so consumers depend on the interface
 * (injected via the STORAGE_SERVICE token from @credebl/storage) rather than a
 * concrete provider. Housed in @credebl/common — a neutral lib that imports
 * neither storage provider — so aws/azure/storage libs can all reference it
 * without a dependency cycle.
 */
export interface StorageService {
  uploadUserCertificate(
    fileBuffer: Buffer,
    ext: string,
    filename: string,
    containerName?: string,
    encoding?: string,
    pathPrefix?: string
  ): Promise<string>;
  uploadFile(fileBuffer: Buffer, filename: string, contentType?: string, folder?: string): Promise<string>;
  uploadCsvFile(key: string, body: unknown): Promise<void>;
  getFileByKey(key: string, containerName?: string): Promise<Buffer>;
  getFile(location: string): Promise<Buffer>;
  deleteFile(location: string): Promise<void>;
  storeObject(persistent: boolean, key: string, body: unknown): Promise<IStorageUploadResult>;
}
