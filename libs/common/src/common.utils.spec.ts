import { didLedgerNamespace, networkNamespace } from './common.utils';

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

describe('didLedgerNamespace', () => {
  it.each([
    ['did:polygon:testnet:0xabc', 'polygon:testnet'],
    ['did:polygon:0xabc', 'polygon:mainnet'],
    ['did:polygon:mainnet:0xabc', 'polygon:mainnet'],
    ['did:ethr:sepolia:0xabc', 'ethr:sepolia'],
    ['did:ethr:0xabc', 'ethr:mainnet'],
    ['did:ethr:mainnet:0xabc', 'ethr:mainnet'],
    ['did:indy:bcovrin:testnet:abc123', 'bcovrin:testnet'],
    ['did:indy:indicio:mainnet:abc123', 'indicio:mainnet']
  ])('reads the ledger namespace of %s from the DID', (did, namespace) => {
    expect(didLedgerNamespace(did)).toBe(namespace);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['abc123'],
    ['did:sov:abc123'],
    ['did:web:example.com'],
    ['did:key:z6Mk'],
    ['did:indy:sovrin:abc123'],
    ['did:polygon'],
    ['not:a:did']
  ])('returns null when %s alone does not say which ledger', (did) => {
    expect(didLedgerNamespace(did)).toBeNull();
  });
});
