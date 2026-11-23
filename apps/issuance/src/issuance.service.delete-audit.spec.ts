import { IssuanceService } from './issuance.service';

describe('IssuanceService.deleteIssuanceRecords audit counts', () => {
  it('counts declined credentials instead of dropping them', async () => {
    const orgDeletedActivity = jest.fn().mockResolvedValue(undefined);
    // Only the collaborators deleteIssuanceRecords touches; the constructor is bypassed.
    const service = Object.assign(Object.create(IssuanceService.prototype), {
      issuanceRepository: {
        getFileUploadDataByOrgId: jest.fn().mockResolvedValue([]),
        deleteFileUploadData: jest.fn().mockResolvedValue(undefined),
        deleteIssuanceRecordsByOrgId: jest.fn().mockResolvedValue({
          deleteResult: { count: 2 },
          recordsToDelete: [{ state: 'declined' }, { state: 'done' }]
        })
      },
      userActivityRepository: { _orgDeletedActivity: orgDeletedActivity },
      logger: { error: jest.fn() }
    }) as IssuanceService;

    await service.deleteIssuanceRecords('org-1', {} as never);

    expect(orgDeletedActivity.mock.calls[0][2].deletedRecordsStatusCount).toEqual({ done: 1, declined: 1 });
  });
});
