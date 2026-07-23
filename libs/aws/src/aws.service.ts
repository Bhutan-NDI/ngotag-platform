import type { IStorageUploadResult, StorageService } from '@credebl/storage/storage.interface';

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { S3 } from 'aws-sdk';
import { promisify } from 'util';

@Injectable()
export class AwsService implements StorageService {
  private s3: S3;
  private s4: S3;
  private s3StoreObject: S3;

  constructor() {
    this.s3 = new S3({
      accessKeyId: process.env.AWS_ACCESS_KEY,
      secretAccessKey: process.env.AWS_SECRET_KEY,
      region: process.env.AWS_REGION
    });

    this.s4 = new S3({
      accessKeyId: process.env.AWS_PUBLIC_ACCESS_KEY,
      secretAccessKey: process.env.AWS_PUBLIC_SECRET_KEY,
      region: process.env.AWS_PUBLIC_REGION
    });

    this.s3StoreObject = new S3({
      accessKeyId: process.env.AWS_S3_STOREOBJECT_ACCESS_KEY,
      secretAccessKey: process.env.AWS_S3_STOREOBJECT_SECRET_KEY,
      region: process.env.AWS_S3_STOREOBJECT_REGION
    });
  }

  async uploadFileToS3Bucket(
    fileBuffer: Buffer,
    ext: string,
    filename: string,
    bucketName: string,
    encoding: string,
    pathAWS: string = ''
  ): Promise<string> {
    const timestamp = Date.now();
    const putObjectAsync = promisify(this.s4.putObject).bind(this.s4);

    try {
      await putObjectAsync({
        Bucket: `${bucketName}`,
        Key: `${pathAWS}/${encodeURIComponent(filename)}-${timestamp}.${ext}`,
        Body: fileBuffer,
        ContentEncoding: encoding,
        ContentType: `image/png`
      });

      const imageUrl = `https://${bucketName}.s3.${process.env.AWS_PUBLIC_REGION}.amazonaws.com/${pathAWS}/${encodeURIComponent(filename)}-${timestamp}.${ext}`;
      return imageUrl;
    } catch (error) {
      throw new HttpException(error, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  // StorageService: certificate / org-logo upload. The logical container maps to the S3 bucket
  // (org-logo bucket by default), so callers stay provider-agnostic.
  async uploadUserCertificate(
    fileBuffer: Buffer,
    ext: string,
    filename: string,
    containerName?: string,
    encoding?: string,
    pathPrefix = ''
  ): Promise<string> {
    const bucketName = containerName || process.env.AWS_ORG_LOGO_BUCKET_NAME || process.env.AWS_BUCKET;
    return this.uploadFileToS3Bucket(fileBuffer, ext, filename, bucketName, encoding ?? 'base64', pathPrefix);
  }

  async uploadFile(fileBuffer: Buffer, filename: string, contentType = 'image/png', folder = ''): Promise<string> {
    const bucketName = process.env.AWS_ORG_LOGO_BUCKET_NAME || process.env.AWS_BUCKET;
    const timestamp = Date.now();
    const key = folder ? `${folder}/${filename}-${timestamp}` : `${filename}-${timestamp}`;

    try {
      await this.s4.upload({ Bucket: bucketName, Key: key, Body: fileBuffer, ContentType: contentType }).promise();
      return `https://${bucketName}.s3.${process.env.AWS_PUBLIC_REGION}.amazonaws.com/${key}`;
    } catch (error) {
      throw new HttpException(error, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async uploadCsvFile(key: string, body: unknown): Promise<void> {
    const params: AWS.S3.PutObjectRequest = {
      Bucket: process.env.AWS_BUCKET,
      Key: key,
      Body: 'string' === typeof body ? body : body.toString()
    };

    try {
      await this.s3.upload(params).promise();
    } catch (error) {
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getFileByKey(key: string, containerName?: string): Promise<Buffer> {
    const params: AWS.S3.GetObjectRequest = {
      Bucket: containerName || process.env.AWS_BUCKET,
      Key: key
    };
    try {
      const data = await this.s3.getObject(params).promise();
      return data.Body as Buffer;
    } catch (error) {
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getFile(location: string): Promise<Buffer> {
    return this.getFileByKey(location);
  }

  async deleteFile(location: string): Promise<void> {
    const params: AWS.S3.DeleteObjectRequest = {
      Bucket: process.env.AWS_BUCKET,
      Key: location
    };
    try {
      await this.s3.deleteObject(params).promise();
    } catch (error) {
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async storeObject(persistent: boolean, key: string, body: unknown): Promise<IStorageUploadResult> {
    const objKey: string = persistent.valueOf() ? `persist/${key}` : `default/${key}`;
    const buf = Buffer.from(JSON.stringify(body));
    const params: AWS.S3.PutObjectRequest = {
      Bucket: process.env.AWS_S3_STOREOBJECT_BUCKET,
      Body: buf,
      Key: objKey,
      ContentEncoding: 'base64',
      ContentType: 'application/json'
    };

    try {
      const receivedData = await this.s3StoreObject.upload(params).promise();
      return { Key: receivedData.Key, Location: receivedData.Location };
    } catch (error) {
      throw new RpcException(error.response ? error.response : error);
    }
  }
}
