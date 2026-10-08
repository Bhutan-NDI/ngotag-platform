import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_PROOF_REQUEST_EXPIRES_IN_SECONDS,
  MIN_PROOF_REQUEST_EXPIRES_IN_SECONDS,
  RequestProofDtoV1,
  RequestProofDtoV2,
  SendProofRequestPayload
} from './request-proof.dto';

// Only the expiresInSeconds errors matter here; the rest of the body is not under test.
type ProofRequestBody = new () => object;

async function errorsFor(dto: ProofRequestBody, body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, body));
  return errors
    .filter((error) => 'expiresInSeconds' === error.property)
    .flatMap((error) => Object.values(error.constraints ?? {}));
}

describe.each([
  ['out-of-band (SendProofRequestPayload)', SendProofRequestPayload],
  ['connection-based v1 (RequestProofDtoV1)', RequestProofDtoV1],
  ['connection-based v2 (RequestProofDtoV2)', RequestProofDtoV2]
] as [string, ProofRequestBody][])('%s expiresInSeconds', (_name, dto) => {
  const expiresInSecondsErrors = (body: object): Promise<string[]> => errorsFor(dto, body);

  it('uses 7 days minus a 1-hour margin as the maximum', () => {
    expect(MIN_PROOF_REQUEST_EXPIRES_IN_SECONDS).toBe(300);
    expect(MAX_PROOF_REQUEST_EXPIRES_IN_SECONDS).toBe(601_200);
  });

  it.each([{}, { expiresInSeconds: undefined }, { expiresInSeconds: null }])(
    'is optional: %p is accepted so agent-controller applies its default',
    async (body) => {
      expect(await expiresInSecondsErrors(body)).toEqual([]);
    }
  );

  it.each([300, 1800, 601_200])('accepts %d', async (value) => {
    expect(await expiresInSecondsErrors({ expiresInSeconds: value })).toEqual([]);
  });

  it.each([299, 0, -1])('rejects %d as below the minimum', async (value) => {
    expect(await expiresInSecondsErrors({ expiresInSeconds: value })).toContain(
      'expiresInSeconds must be at least 300'
    );
  });

  it('rejects a value above the purge ceiling', async () => {
    expect(await expiresInSecondsErrors({ expiresInSeconds: 601_201 })).toContain(
      'expiresInSeconds must be at most 601200'
    );
  });

  it.each([1.5, '600', 'abc', true])('rejects %p as not a whole number', async (value) => {
    expect(await expiresInSecondsErrors({ expiresInSeconds: value })).toContain(
      'expiresInSeconds must be a whole number of seconds'
    );
  });
});
