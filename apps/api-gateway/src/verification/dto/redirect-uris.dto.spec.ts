import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterRedirectUrisDto, UpdateRedirectUrisDto } from './redirect-uris.dto';

async function errorsFor(
  dto: typeof RegisterRedirectUrisDto | typeof UpdateRedirectUrisDto,
  body: object
): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, body));
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('redirect URI DTOs', () => {
  it('requires at least one URI when registering', async () => {
    expect(await errorsFor(RegisterRedirectUrisDto, { redirectUris: [] })).toContain('redirectUris must not be empty');
  });

  it('accepts an empty list on update, so the allowlist can be revoked', async () => {
    expect(await errorsFor(UpdateRedirectUrisDto, { redirectUris: [] })).toEqual([]);
  });

  it('applies the same per-URI rules to both', async () => {
    for (const dto of [RegisterRedirectUrisDto, UpdateRedirectUrisDto]) {
      expect(await errorsFor(dto, { redirectUris: ['https://rp.example.com/return'] })).toEqual([]);
      expect(await errorsFor(dto, { redirectUris: ['not a url'] })).toContain(
        'Each redirect URI must be a valid http(s) URL'
      );
      expect(await errorsFor(dto, { redirectUris: ['https://rp.example.com/a,b'] })).toContain(
        'Redirect URIs must not contain commas'
      );
      expect(await errorsFor(dto, { redirectUris: 'https://rp.example.com' })).toContain(
        'redirectUris must be an array'
      );
    }
  });
});
