/**
 * Regression tests for ReceiveInvitationUrlDTO. @Transform(({ value }) => trim(value)) was applied
 * to boolean/int fields -- cast.helper.ts's trim() only handles strings, returning undefined for
 * anything else, so every one of these fields was silently wiped regardless of what was sent
 * (confirmed against real traffic: the agent only ever received `invitationUrl`). Also confirmed
 * this is a develop-only regression (`bfb37250`, Jul 2024) -- pipeline-implementation and the
 * feat/guardianship-wallet branch never had the Transform on these fields.
 *
 * label is now required, matching the agent's own contract (ReceiveInvitationByUrlProps /
 * AcceptInvitationConfig requires it on both agent-controller's old multi-tenancy endpoint and
 * its current didcomm/oob one) -- a missing label previously reached the agent and came back as
 * an opaque error instead of failing validation locally with a clear message.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReceiveInvitationUrlDTO } from './cloudWallet.dto';

describe('ReceiveInvitationUrlDTO', () => {
  it('does not wipe autoAcceptConnection/autoAcceptInvitation/reuseConnection', async () => {
    const instance = plainToInstance(ReceiveInvitationUrlDTO, {
      invitationUrl: 'https://example.com?oob=abc',
      label: 'My Wallet',
      autoAcceptConnection: true,
      autoAcceptInvitation: false,
      reuseConnection: true
    });

    expect(instance.autoAcceptConnection).toBe(true);
    expect(instance.autoAcceptInvitation).toBe(false);
    expect(instance.reuseConnection).toBe(true);

    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('does not wipe acceptInvitationTimeoutMs', async () => {
    const instance = plainToInstance(ReceiveInvitationUrlDTO, {
      invitationUrl: 'https://example.com?oob=abc',
      label: 'My Wallet',
      acceptInvitationTimeoutMs: 5000
    });

    expect(instance.acceptInvitationTimeoutMs).toBe(5000);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rejects a request with no label, instead of letting it reach the agent', async () => {
    const instance = plainToInstance(ReceiveInvitationUrlDTO, {
      invitationUrl: 'https://example.com?oob=abc'
    });

    const errors = await validate(instance);
    expect(errors.some((error) => 'label' === error.property)).toBe(true);
  });
});
