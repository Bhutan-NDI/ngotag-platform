/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, prefer-destructuring */
import { escapeHtml, KeyExportAlertKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const migration = {
  id: 'm1',
  orgId: ORG_ID,
  targetAdminEndpoint: 'https://admin.org.example.com:8443/secret/path?token=NOPE'
} as never;

const build = (
  options: { recipients?: string[]; orgName?: string | null; emailFrom?: string | null; send?: jest.Mock } = {}
) => {
  const migrationRepository = {
    getExportAlertRecipients: jest.fn().mockResolvedValue(options.recipients ?? ['owner@x.org', 'admin@x.org']),
    getOrgName: jest.fn().mockResolvedValue('orgName' in options ? options.orgName : 'Acme Ltd'),
    getUserEmail: jest.fn().mockResolvedValue('owner@x.org')
  };
  const agentServiceRepository = {
    getPlatformConfigDetails: jest
      .fn()
      .mockResolvedValue(
        'emailFrom' in options ? { emailFrom: options.emailFrom } : { emailFrom: 'noreply@platform.org' }
      )
  };
  const sendEmail = options.send ?? jest.fn().mockResolvedValue(true);
  const logger = { error: jest.fn() };
  const service = new OrgAgentMigrationAlertService(
    agentServiceRepository as never,
    migrationRepository as never,
    { sendEmail } as never,
    logger as never
  );
  return { service, migrationRepository, sendEmail, logger };
};

describe('OrgAgentMigrationAlertService', () => {
  it("looks for the org's owners and the platform-admin organisation's members", async () => {
    const { service, migrationRepository } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    expect(migrationRepository.getExportAlertRecipients).toHaveBeenCalledWith(ORG_ID, 'Platform-admin');
  });

  it('sends each recipient their own email and reports how many went out', async () => {
    const { service, sendEmail } = build();

    const result = await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    expect(result).toEqual({ recipients: 2, sent: 2 });
    expect(sendEmail.mock.calls.map(([email]) => email.emailTo)).toEqual(['owner@x.org', 'admin@x.org']);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      emailFrom: 'noreply@platform.org',
      emailSubject: '[Security] The organisation’s signing keys were exported for a rehearsal'
    });
  });

  it('says who did it, for which org and where the keys are going, but only the host of that address', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    const { emailText, emailHtml } = sendEmail.mock.calls[0][0];
    for (const body of [emailText, emailHtml]) {
      expect(body).toContain('Acme Ltd');
      expect(body).toContain('owner@x.org');
      expect(body).toContain('admin.org.example.com:8443');
      expect(body).not.toMatch(/secret\/path|NOPE/);
    }
  });

  it('uses a different subject when a move is started', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.MOVE_STARTED, USER_ID);

    expect(sendEmail.mock.calls[0][0].emailSubject).toBe('[Security] A wallet move was started');
  });

  it('uses its own subject for the move-day export', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.MOVE_EXPORT, USER_ID);

    expect(sendEmail.mock.calls[0][0].emailSubject).toBe(
      '[Security] The organisation’s signing keys were exported for the move'
    );
    expect(sendEmail.mock.calls[0][0].emailText).toContain('to move it to its own agent');
  });

  it('words a disaster restore as done by a platform admin, about the agent that was lost', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.DISASTER_RESTORE, USER_ID);

    const { emailSubject, emailText, emailHtml } = sendEmail.mock.calls[0][0];
    expect(emailSubject).toBe('[Security] A wallet move was rolled back');
    for (const body of [emailText, emailHtml]) {
      expect(body).toContain('A platform admin');
      expect(body).not.toContain('An organisation owner');
      expect(body).toContain('The agent that was lost');
      expect(body).not.toContain('Keys are going to');
    }
  });

  it('words a stuck move as the platform failing to finish after the switch, about the new agent', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.MOVE_STUCK, USER_ID);

    const { emailSubject, emailText, emailHtml } = sendEmail.mock.calls[0][0];
    expect(emailSubject).toBe('[Security] A wallet move is stuck after the switch');
    for (const body of [emailText, emailHtml]) {
      expect(body).toContain('The platform');
      expect(body).toContain('The organisation stays paused');
      expect(body).toContain('The new agent');
      expect(body).not.toContain('An organisation owner');
      expect(body).not.toContain('Keys are going to');
    }
  });

  it('keeps the owner wording and the key destination for the export alerts', async () => {
    const { service, sendEmail } = build();

    await service.alertKeyExport(migration, KeyExportAlertKind.MOVE_EXPORT, USER_ID);

    expect(sendEmail.mock.calls[0][0].emailText).toContain('An organisation owner');
    expect(sendEmail.mock.calls[0][0].emailText).toContain('Keys are going to');
  });

  it('escapes anything the owner typed before it goes into the HTML body', async () => {
    const { service, sendEmail } = build({ orgName: '<script>alert(1)</script> & Co' });

    await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    const { emailHtml } = sendEmail.mock.calls[0][0];
    expect(emailHtml).not.toContain('<script>');
    expect(emailHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
  });

  it('keeps going when one recipient fails, and counts only what was sent', async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error('mailbox full')).mockResolvedValueOnce(true);
    const { service, logger } = build({ send });

    const result = await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    expect(result).toEqual({ recipients: 2, sent: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not count an email the provider reports as not sent', async () => {
    const { service } = build({ send: jest.fn().mockResolvedValue(false) });

    await expect(service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID)).resolves.toEqual({
      recipients: 2,
      sent: 0
    });
  });

  it.each([
    ['there are no recipients', { recipients: [] }],
    ['no sender address is configured', { emailFrom: null }]
  ])('sends nothing and reports zero when %s', async (_name, options) => {
    const { service, sendEmail } = build(options);

    const result = await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('falls back to the org id when the org name cannot be read', async () => {
    const { service, sendEmail } = build({ orgName: null });

    await service.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, USER_ID);

    expect(sendEmail.mock.calls[0][0].emailText).toContain(ORG_ID);
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that can break out of text and attributes', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
});
