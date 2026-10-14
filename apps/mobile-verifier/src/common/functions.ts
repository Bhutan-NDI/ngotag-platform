import { decryptClientCredential } from '@credebl/common/cast.helper';

// CryptoJS AES output ("Salted__" base64) always starts with this prefix. Lets rows saved
// before url/clientId were encrypted keep working instead of failing to decrypt.
const CRYPTOJS_SALTED_PREFIX = 'U2FsdGVkX1';

export const decryptIfEncrypted = async (value: string): Promise<string> =>
  value?.startsWith(CRYPTOJS_SALTED_PREFIX) ? decryptClientCredential(value) : value;

export interface SkipTake {
  skip: number;
  take: number;
}

export const getSkipTake = (page: number, pageSize: number): SkipTake => {
  const skip = (page - 1) * pageSize;
  const take = pageSize;
  return { skip, take };
};

export interface NextPrevPages {
  nextPage: number | null;
  prevPage: number | null;
}

export const getNextPrevPages = (totalItems: number, page: number, pageSize: number): NextPrevPages => {
  const totalPages = Math.ceil(totalItems / pageSize);
  let nextPage: number | null = null;
  let prevPage: number | null = null;
  if (page < totalPages) {
    nextPage = page + 1;
  }

  if (1 < page) {
    if (page >= totalPages) {
      prevPage = 0 !== totalPages ? totalPages : null;
    } else {
      prevPage = page - 1;
    }
  }
  return { nextPage, prevPage };
};
