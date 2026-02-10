import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';

@Injectable()
export class AzureStorageService {
  private readonly logger = new Logger(AzureStorageService.name);
  private blobServiceClient: BlobServiceClient;
  private containerClient: ContainerClient;

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'logo';

    if (connectionString) {
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      this.containerClient = this.blobServiceClient.getContainerClient(containerName);
    } else {
      this.logger.warn('AZURE_STORAGE_CONNECTION_STRING not configured');
    }
  }

  /**
   * Upload a file to Azure Blob Storage (compatible with AWS S3 interface)
   * @param fileBuffer - The file buffer to upload
   * @param ext - File extension (e.g., 'png', 'jpg')
   * @param filename - Base filename
   * @param bucketName - Container name (maps to Azure container, can be ignored if using default)
   * @param encoding - Content encoding
   * @param pathPrefix - Path prefix within the container
   * @returns The URL of the uploaded blob
   */
  async uploadUserCertificate(
    fileBuffer: Buffer,
    ext: string,
    filename: string,
    bucketName?: string,
    encoding?: string,
    pathPrefix: string = ''
  ): Promise<string> {
    if (!this.blobServiceClient) {
      throw new HttpException('Azure Storage not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const timestamp = Date.now();
    const blobName = pathPrefix 
      ? `${pathPrefix}/${encodeURIComponent(filename)}-${timestamp}.${ext}`
      : `${encodeURIComponent(filename)}-${timestamp}.${ext}`;

    try {
      // Use specified container or default
      const containerName = bucketName || process.env.AZURE_STORAGE_CONTAINER_NAME || 'logo';
      const container = this.blobServiceClient.getContainerClient(containerName);
      
      // Ensure container exists with public access for blobs
      await container.createIfNotExists({
        access: 'blob' // Allow public read access to blobs
      });

      const blockBlobClient = container.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(fileBuffer, {
        blobHTTPHeaders: {
          blobContentType: `image/${ext}`,
          blobContentEncoding: encoding
        }
      });

      // Return the public URL
      return blockBlobClient.url;
    } catch (error) {
      this.logger.error(`Error uploading to Azure Blob Storage: ${JSON.stringify(error)}`);
      throw new HttpException(error.message || 'Upload failed', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  /**
   * Upload a file and return the URL
   * Simplified method for logo uploads
   */
  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    contentType: string = 'image/png',
    folder: string = ''
  ): Promise<string> {
    if (!this.blobServiceClient) {
      throw new HttpException('Azure Storage not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const timestamp = Date.now();
    const blobName = folder 
      ? `${folder}/${filename}-${timestamp}`
      : `${filename}-${timestamp}`;

    try {
      await this.containerClient.createIfNotExists({
        access: 'blob'
      });

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

  /**
   * Delete a blob from storage
   */
  async deleteFile(blobUrl: string): Promise<void> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      // Extract blob name from URL
      const url = new URL(blobUrl);
      const pathParts = url.pathname.split('/');
      const containerName = pathParts[1];
      const blobName = pathParts.slice(2).join('/');

      const container = this.blobServiceClient.getContainerClient(containerName);
      const blobClient = container.getBlobClient(blobName);
      
      await blobClient.deleteIfExists();
    } catch (error) {
      this.logger.error(`Error deleting blob: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Delete failed');
    }
  }

  /**
   * Get a blob's content
   */
  async getFile(blobUrl: string): Promise<Buffer> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      const url = new URL(blobUrl);
      const pathParts = url.pathname.split('/');
      const containerName = pathParts[1];
      const blobName = pathParts.slice(2).join('/');

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

  /**
   * Store JSON object (compatible with S3 storeObject)
   */
  async storeObject(persistent: boolean, key: string, body: unknown): Promise<{ Location: string }> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    const objKey = persistent ? `persist/${key}` : `default/${key}`;
    const buf = Buffer.from(JSON.stringify(body));

    try {
      await this.containerClient.createIfNotExists({
        access: 'blob'
      });

      const blockBlobClient = this.containerClient.getBlockBlobClient(objKey);

      await blockBlobClient.uploadData(buf, {
        blobHTTPHeaders: {
          blobContentType: 'application/json',
          blobContentEncoding: 'base64'
        }
      });

      return { Location: blockBlobClient.url };
    } catch (error) {
      this.logger.error(`Error storing object: ${JSON.stringify(error)}`);
      throw new RpcException(error.message || 'Store failed');
    }
  }

  /**
   * Upload CSV file
   */
  async uploadCsvFile(key: string, body: unknown): Promise<void> {
    if (!this.blobServiceClient) {
      throw new RpcException('Azure Storage not configured');
    }

    try {
      await this.containerClient.createIfNotExists({
        access: 'blob'
      });

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
}
