import { NATSReconnects } from '@credebl/enum/enum';
import { Authenticator, nkeyAuthenticator } from 'nats';
import { CommonConstants } from './common.constant';

export const getNatsOptions = (
  serviceName?: string, nkeySeed?: string
): {
  servers: string[];
  authenticator?: Authenticator;
  maxReconnectAttempts: NATSReconnects;
  reconnectTimeWait: NATSReconnects;
  queue?: string;
} => {
  const baseOptions = {
    servers: `${process.env.NATS_URL}`.split(','),
    maxReconnectAttempts: NATSReconnects.maxReconnectAttempts,
    reconnectTimeWait: NATSReconnects.reconnectTimeWait,
    queue: `${CommonConstants.API_GATEWAY_SERVICE}`
  };

  if (nkeySeed) {
    return {
      ...baseOptions,
      authenticator: nkeyAuthenticator(new TextEncoder().encode(nkeySeed))
    };
  } 
  return baseOptions;
};

