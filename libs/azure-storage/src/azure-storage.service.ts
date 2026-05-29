import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

export interface IStorageUploadResult {
  Key: string;
  Location: string;
}

@Injectable()
export class AzureStorageService {
  private readonly logger = new Logger(AzureStorageService.name);
  private blobServiceClient: BlobServiceClient;
  private containerClient: ContainerClient;
  private storeObjectContainerClient: ContainerClient;

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'logo';

    if (connectionString) {
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      this.containerClient = this.blobServiceClient.getContainerClient(containerName);
    } else {
      this.logger.warn('AZURE_STORAGE_CONNECTION_STRING not configured');
    }

    const storeObjectConnectionString = process.env.AZURE_STOREOBJECT_CONNECTION_STRING || connectionString;
    const storeObjectContainerName = process.env.AZURE_STOREOBJECT_CONTAINER_NAME || 'shortening-url';

    if (storeObjectConnectionString) {
      const storeObjectBlobServiceClient = BlobServiceClient.fromConnectionString(storeObjectConnectionString);
      this.storeObjectContainerClient = storeObjectBlobServiceClient.getContainerClient(storeObjectContainerName);
    } else {
      this.logger.warn('Azure storeObject storage is not configured');
    }
  }

  async uploadUserCertificate(
    fileBuffer: Buffer,
    ext: string,
    filename: string,
    containerName?: string,
    encoding?: string,
    pathPrefix = ''
  ): Promise<string> {
    if (!this.blobServiceClient) {
      throw new HttpException('Azure Storage not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const timestamp = Date.now();
    const blobName = pathPrefix
      ? `${pathPrefix}/${encodeURIComponent(filename)}-${timestamp}.${ext}`
      : `${encodeURIComponent(filename)}-${timestamp}.${ext}`;

    try {
      const container = this.blobServiceClient.getContainerClient(
        containerName || process.env.AZURE_STORAGE_CONTAINER_NAME || 'logo'
      );
      await container.createIfNotExists({ access: 'blob' });

      const blockBlobClient = container.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(fileBuffer, {
        blobHTTPHeaders: {
          blobContentType: `image/${ext}`,
          blobContentEncoding: encoding
        }
      });

      return blockBlobClient.url;
    } catch (error) {
      this.logger.error(`Error uploading to Azure Blob Storage: ${JSON.stringify(error)}`);
      throw new HttpException(error.message || 'Upload failed', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    contentType = 'image/png',
    folder = ''
  ): Promise<string> {
    if (!this.containerClient) {
      throw new HttpException('Azure Storage not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const timestamp = Date.now();
    const blobName = folder ? `${folder}/${filename}-${timestamp}` : `${filename}-${timestamp}`;

    try {
      await this.containerClient.createIfNotExists({ access: 'blob' });

      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(fileBuffer, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });

      return blockBlobClient.url;
    } catch (error) {
      this.logger.error(`Error uploading file: ${JSON.stringify(error)}`);
      throw new HttpException(error.message || 'Upload failed', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async deleteFile(blobUrl: string): Promise<void> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      const { containerName, blobName } = this.parseBlobUrl(blobUrl);
      const container = this.blobServiceClient.getContainerClient(containerName);
      const blobClient = container.getBlobClient(blobName);

      await blobClient.deleteIfExists();
    } catch (error) {
      this.logger.error(`Error deleting blob: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Delete failed');
    }
  }

  async getFile(blobUrl: string): Promise<Buffer> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      const { containerName, blobName } = this.parseBlobUrl(blobUrl);
      const container = this.blobServiceClient.getContainerClient(containerName);
      const blobClient = container.getBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      const chunks: Uint8Array[] = [];

      for await (const chunk of downloadResponse.readableStreamBody as NodeJS.ReadableStream) {
        chunks.push(chunk as Uint8Array);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error(`Error getting blob: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Get failed');
    }
  }

  async storeObject(persistent: boolean, key: string, body: unknown): Promise<IStorageUploadResult> {
    if (!this.storeObjectContainerClient) {
      throw new RpcException(
        'Azure Storage not configured for storeObject. Set AZURE_STOREOBJECT_CONNECTION_STRING or AZURE_STORAGE_CONNECTION_STRING'
      );
    }

    const objKey = persistent ? `persist/${key}` : `default/${key}`;
    const buf = Buffer.from(JSON.stringify(body));

    try {
      await this.storeObjectContainerClient.createIfNotExists({ access: 'blob' });

      const blockBlobClient = this.storeObjectContainerClient.getBlockBlobClient(objKey);
      await blockBlobClient.uploadData(buf, {
        blobHTTPHeaders: {
          blobContentType: 'application/json'
        }
      });

      return {
        Key: objKey,
        Location: blockBlobClient.url
      };
    } catch (error) {
      this.logger.error(`Error storing object: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Store failed');
    }
  }

  async uploadCsvFile(key: string, body: unknown): Promise<void> {
    if (!this.containerClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      await this.containerClient.createIfNotExists({ access: 'blob' });

      const blockBlobClient = this.containerClient.getBlockBlobClient(key);
      const content = 'string' === typeof body ? body : body.toString();

      await blockBlobClient.uploadData(Buffer.from(content), {
        blobHTTPHeaders: {
          blobContentType: 'text/csv'
        }
      });
    } catch (error) {
      this.logger.error(`Error uploading CSV: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Upload failed');
    }
  }

  async getFileByKey(key: string, containerName?: string): Promise<Buffer> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      const container = this.blobServiceClient.getContainerClient(
        containerName || process.env.AZURE_STORAGE_CONTAINER_NAME || 'logo'
      );
      const blobClient = container.getBlobClient(key);
      const downloadResponse = await blobClient.download();
      const chunks: Uint8Array[] = [];

      for await (const chunk of downloadResponse.readableStreamBody as NodeJS.ReadableStream) {
        chunks.push(chunk as Uint8Array);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error(`Error getting blob by key: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Get failed');
    }
  }

  private parseBlobUrl(blobUrl: string): { containerName: string; blobName: string } {
    const url = new URL(blobUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const [containerName, ...blobNameParts] = pathParts;

    return {
      containerName,
      blobName: blobNameParts.join('/')
    };
  }
}
