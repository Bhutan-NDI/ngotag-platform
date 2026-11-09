/**
 * Regression test for trim()'s non-string fallback (#84 review, second finding). Previously
 * returned `undefined` implicitly for any non-string input, which combined with @IsOptional()
 * silently wiped boolean/int DTO fields on every request with zero validation error -- the root
 * cause behind the receive-invitation-url boolean-wiping bug this PR's first commit fixed
 * symptomatically (by removing @Transform(trim) from the 4 affected fields in that one DTO).
 */
import { createOobJsonldIssuancePayload, trim } from './cast.helper';

describe('trim', () => {
  it('trims a real string', () => {
    expect(trim('  hello  ')).toBe('hello');
  });

  it('returns non-string input unchanged instead of coercing it to undefined', () => {
    expect(trim(true as never)).toBe(true);
    expect(trim(false as never)).toBe(false);
    expect(trim(42 as never)).toBe(42);
    expect(trim(0 as never)).toBe(0);
  });

  it('passes through null/undefined unchanged', () => {
    expect(trim(null as never)).toBeNull();
    expect(trim(undefined as never)).toBeUndefined();
  });
});

describe('createOobJsonldIssuancePayload', () => {
  const credentialData = { ['email_identifier']: 'holder@example.com', name: 'Holder' };
  function proofTypeFor(orgDid: string): string {
    const payload = createOobJsonldIssuancePayload(
      {
        schemaName: 'Membership',
        schemaLedgerId: 'https://schema.example.com/membership',
        credentialData,
        orgDid,
        orgId: 'org-1'
      } as never,
      {} as never
    );
    return payload.credentialOffer[0].options.proofType;
  }

  // The issuing agent picks the key that matches the suite; a secp256k1 DID asked for an Ed25519
  // proof has none, so email and bulk JSON-LD issuance failed for did:ethr orgs.
  it.each([
    [
      'did:ethr:sepolia:0x025685d7548c6e21bfa56249594aba0ee7f9cfe810e3909d0c0e8a8bbb86244f9c',
      'EcdsaSecp256k1Signature2019'
    ],
    ['did:polygon:testnet:0x4a09b8CB511cca4Ca1c5dB0475D0e07bFc96EF47', 'EcdsaSecp256k1Signature2019'],
    ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'Ed25519Signature2018']
  ])('asks a %s issuer for %s', (orgDid, proofType) => {
    expect(proofTypeFor(orgDid)).toBe(proofType);
  });
});
