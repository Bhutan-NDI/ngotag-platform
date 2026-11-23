/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ResponseType {
  statusCode: number;
  message: string | string[];
  data?: any;
  error?: any;
  pagination?: Pagination;
}

export interface Pagination {
  total: number;
  currentPage: number;
  pageSize: number;
  nextPage: number | null;
  prevPage: number | null;
}
