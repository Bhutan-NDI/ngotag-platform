import { ConnectionService } from './connection.service';

describe('ConnectionService.deleteConnectionRecords audit counts', () => {
  it('counts declined connections instead of dropping them', async () => {
    const orgDeletedActivity = jest.fn().mockResolvedValue(undefined);
    const service = new ConnectionService(
      {} as never,
      {} as never,
      {
        deleteConnectionRecordsByOrgId: jest.fn().mockResolvedValue({
          deleteConnectionRecords: { count: 3 },
          getConnectionRecords: [{ state: 'declined' }, { state: 'declined' }, { state: 'completed' }]
        })
      } as never,
      { _orgDeletedActivity: orgDeletedActivity } as never,
      { error: jest.fn() } as never,
      {} as never
    );

    await service.deleteConnectionRecords('org-1', {} as never);

    expect(orgDeletedActivity.mock.calls[0][2].deletedRecordsStatusCount).toEqual({ completed: 1, declined: 2 });
  });
});
