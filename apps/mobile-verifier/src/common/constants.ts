export enum PrismaError {
  RecordDoesNotExist = 'P2025',
  UniqueConstraintFailed = 'P2002',
  ForeignKeyConstraintFailed = 'P2003'
}

export enum ProofRequestType {
  MOBILE_VERIFIER_ACCESS_CRED = 'MOBILE_VERIFIER_ACCESS_CRED',
  DIF = 'dif'
}
