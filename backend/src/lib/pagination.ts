import { Request } from 'express';

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

const MAX_PAGE_SIZE = 200;

export function pageParams(req: Request, defaultSize = 20): PageParams {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(String(req.query.pageSize ?? String(defaultSize)), 10) || defaultSize)
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function intParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function strParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}
