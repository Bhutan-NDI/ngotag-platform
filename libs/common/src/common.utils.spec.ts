import { networkNamespace } from './common.utils';

describe('networkNamespace', () => {
  it('resolves a did:ethr sepolia DID to the sepolia namespace, not mainnet', () => {
    expect(networkNamespace('did:ethr:sepolia:0xabc')).toBe('ethr:sepolia');
  });

  it('resolves a did:ethr mainnet DID to the mainnet namespace', () => {
    expect(networkNamespace('did:ethr:mainnet:0xabc')).toBe('ethr:mainnet');
  });

  it('resolves a did:polygon testnet DID to the testnet namespace', () => {
    expect(networkNamespace('did:polygon:testnet:0xabc')).toBe('polygon:testnet');
  });

  it('resolves a did:polygon mainnet DID to the mainnet namespace', () => {
    expect(networkNamespace('did:polygon:mainnet:0xabc')).toBe('polygon:mainnet');
  });

  it('passes through the namespace segment unchanged for other DID methods', () => {
    expect(networkNamespace('did:indy:bcovrin:testnet:abc123')).toBe('indy');
  });
});
