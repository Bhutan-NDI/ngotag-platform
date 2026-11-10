import { didLedgerNamespace, jsonLdProofTypeForDid, networkNamespace } from './common.utils';

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

describe('jsonLdProofTypeForDid', () => {
  it.each([
    [
      'did:ethr:sepolia:0x025685d7548c6e21bfa56249594aba0ee7f9cfe810e3909d0c0e8a8bbb86244f9c',
      'EcdsaSecp256k1Signature2019'
    ],
    ['did:ethr:0x025685d7548c6e21bfa56249594aba0ee7f9cfe810e3909d0c0e8a8bbb86244f9c', 'EcdsaSecp256k1Signature2019'],
    ['did:polygon:testnet:0x4a09b8CB511cca4Ca1c5dB0475D0e07bFc96EF47', 'EcdsaSecp256k1Signature2019'],
    ['did:polygon:0x4a09b8CB511cca4Ca1c5dB0475D0e07bFc96EF47', 'EcdsaSecp256k1Signature2019'],
    ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'Ed25519Signature2018'],
    ['did:web:org.example.com', 'Ed25519Signature2018'],
    ['did:indy:bcovrin:testnet:abc', 'Ed25519Signature2018']
  ])('signs %s with %s', (did, proofType) => {
    expect(jsonLdProofTypeForDid(did)).toBe(proofType);
  });

  it('reads the method, not any segment: a did:web host named after a chain is still Ed25519', () => {
    expect(jsonLdProofTypeForDid('did:web:polygon.example.com')).toBe('Ed25519Signature2018');
    expect(jsonLdProofTypeForDid('did:web:ethr.example.com')).toBe('Ed25519Signature2018');
  });

  it('falls back to Ed25519 for a missing DID', () => {
    expect(jsonLdProofTypeForDid(undefined)).toBe('Ed25519Signature2018');
    expect(jsonLdProofTypeForDid(null)).toBe('Ed25519Signature2018');
  });
});
