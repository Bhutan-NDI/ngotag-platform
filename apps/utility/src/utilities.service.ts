import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { UtilitiesRepository } from './utilities.repository';
import { AwsService } from '@credebl/aws';
import { AzureStorageService } from '@credebl/azure-storage';
import { S3 } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class UtilitiesService {
    constructor(
        private readonly logger: Logger,
        private readonly utilitiesRepository: UtilitiesRepository,
        private readonly awsService: AwsService,
        private readonly azureStorageService: AzureStorageService
    ) { }

    async createAndStoreShorteningUrl(payload): Promise<string> {
        try {
            const { credentialId, schemaId, credDefId, invitationUrl, attributes } = payload;
            const invitationPayload = {
                referenceId: credentialId,
                invitationPayload: {
                    schemaId, 
                    credDefId,
                    invitationUrl, 
                    attributes
                }
            };
            await this.utilitiesRepository.saveShorteningUrl(invitationPayload);
            return `${process.env.API_GATEWAY_PROTOCOL}://${process.env.API_ENDPOINT}/invitation/qr-code/${credentialId}`;
        } catch (error) {
            this.logger.error(`[createAndStoreShorteningUrl] - error in create shortening url: ${JSON.stringify(error)}`);
            throw new RpcException(error);
        }
    }

    async getShorteningUrl(referenceId: string): Promise<object> {
        try {
            const getShorteningUrl = await this.utilitiesRepository.getShorteningUrl(referenceId);

            const getInvitationUrl  = {
                referenceId: getShorteningUrl.referenceId,
                invitationPayload: getShorteningUrl.invitationPayload
            };
            
            return getInvitationUrl;
        } catch (error) {
            this.logger.error(`[getShorteningUrl] - error in get shortening url: ${JSON.stringify(error)}`);
            throw new RpcException(error);
        }
    }

    async storeObject(payload: {persistent: boolean, storeObj: unknown}): Promise<string> {
        try {
            const uuid = uuidv4();
            const storageProvider = process.env.STORAGE_PROVIDER?.toLowerCase() || 'aws';
            
            if ('azure' === storageProvider) {
                // Use Azure Blob Storage
                const uploadResult = await this.azureStorageService.storeObject(
                    payload.persistent, 
                    uuid, 
                    payload.storeObj
                );
                // Use AZURE_STOREOBJECT_DOMAIN if set, otherwise use the blob URL directly
                const domain = process.env.AZURE_STOREOBJECT_DOMAIN;
                const url: string = domain 
                    ? `${domain}/${uploadResult.Key}` 
                    : uploadResult.Location;
                return url;
            } else {
                // Use AWS S3 (default)
                const uploadResult: S3.ManagedUpload.SendData = await this.awsService.storeObject(
                    payload.persistent, 
                    uuid, 
                    payload.storeObj
                );
                const url: string = `${process.env.SHORTENED_URL_DOMAIN}/${uploadResult.Key}`;
                return url;
            }
        } catch (error) {
            this.logger.error(error);
            const storageProvider = process.env.STORAGE_PROVIDER?.toLowerCase() || 'aws';
            throw new Error(`An error occurred while uploading data to ${storageProvider.toUpperCase()} storage.`);
        }
    }
}
