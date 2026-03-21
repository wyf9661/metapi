import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, schema } from '../db/index.js';
import type { ProxyResourceOwner } from '../middleware/auth.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export const LOCAL_PROXY_FILE_ID_PREFIX = 'file-metapi-';

export type ProxyFileRecord = {
  publicId: string;
  ownerType: ProxyResourceOwner['ownerType'];
  ownerId: string;
  filename: string;
  mimeType: string;
  purpose: string | null;
  byteSize: number;
  sha256: string;
  contentBase64: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
};

export type SaveProxyFileInput = ProxyResourceOwner & {
  filename: string;
  mimeType: string;
  purpose?: string | null;
  contentBase64: string;
  byteSize?: number | null;
  sha256?: string | null;
};

export type CreateProxyFileInput = {
  owner: ProxyResourceOwner;
  filename: string;
  mimeType: string;
  purpose?: string | null;
  buffer: Buffer;
};

function buildPublicFileId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${LOCAL_PROXY_FILE_ID_PREFIX}${timePart}-${randomPart}`;
}

function normalizeFilename(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'upload.bin';
}

function toByteSize(contentBase64: string): number {
  return Buffer.from(contentBase64, 'base64').byteLength;
}

function rowToRecord(row: typeof schema.proxyFiles.$inferSelect): ProxyFileRecord {
  return {
    publicId: row.publicId,
    ownerType: row.ownerType as ProxyResourceOwner['ownerType'],
    ownerId: row.ownerId,
    filename: row.filename,
    mimeType: row.mimeType,
    purpose: row.purpose,
    byteSize: row.byteSize,
    sha256: row.sha256,
    contentBase64: row.contentBase64,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

function ownerWhere(owner: ProxyResourceOwner) {
  return and(
    eq(schema.proxyFiles.ownerType, owner.ownerType),
    eq(schema.proxyFiles.ownerId, owner.ownerId),
  );
}

export async function saveProxyFile(input: SaveProxyFileInput): Promise<ProxyFileRecord> {
  const publicId = buildPublicFileId();
  const now = formatUtcSqlDateTime(new Date());
  const filename = normalizeFilename(input.filename);
  const byteSize = typeof input.byteSize === 'number' && Number.isFinite(input.byteSize)
    ? Math.max(0, Math.trunc(input.byteSize))
    : toByteSize(input.contentBase64);
  const sha256 = typeof input.sha256 === 'string' && input.sha256.trim().length > 0
    ? input.sha256.trim()
    : createHash('sha256').update(Buffer.from(input.contentBase64, 'base64')).digest('hex');

  await db.insert(schema.proxyFiles).values({
    publicId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    filename,
    mimeType: input.mimeType,
    purpose: input.purpose?.trim() || null,
    byteSize,
    sha256,
    contentBase64: input.contentBase64,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }).run();

  return (await getProxyFileByPublicIdForOwner(publicId, input))!;
}

export async function createProxyFile(input: CreateProxyFileInput): Promise<ProxyFileRecord> {
  return saveProxyFile({
    ownerType: input.owner.ownerType,
    ownerId: input.owner.ownerId,
    filename: input.filename,
    mimeType: input.mimeType,
    purpose: input.purpose,
    byteSize: input.buffer.byteLength,
    sha256: createHash('sha256').update(input.buffer).digest('hex'),
    contentBase64: input.buffer.toString('base64'),
  });
}

export async function listProxyFilesByOwner(owner: ProxyResourceOwner): Promise<ProxyFileRecord[]> {
  const rows = await db.select().from(schema.proxyFiles)
    .where(and(ownerWhere(owner), isNull(schema.proxyFiles.deletedAt)))
    .orderBy(desc(schema.proxyFiles.createdAt))
    .all();
  return rows.map(rowToRecord);
}

export async function getProxyFileByPublicId(publicId: string): Promise<ProxyFileRecord | null> {
  const row = await db.select().from(schema.proxyFiles)
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      isNull(schema.proxyFiles.deletedAt),
    ))
    .get();
  return row ? rowToRecord(row) : null;
}

export async function getProxyFileByPublicIdForOwner(
  publicId: string,
  owner: ProxyResourceOwner,
): Promise<ProxyFileRecord | null> {
  const row = await db.select().from(schema.proxyFiles)
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      ownerWhere(owner),
      isNull(schema.proxyFiles.deletedAt),
    ))
    .get();
  return row ? rowToRecord(row) : null;
}

export async function getProxyFileContentByPublicIdForOwner(
  publicId: string,
  owner: ProxyResourceOwner,
): Promise<{ filename: string; mimeType: string; buffer: Buffer } | null> {
  const record = await getProxyFileByPublicIdForOwner(publicId, owner);
  if (!record) return null;
  return {
    filename: record.filename,
    mimeType: record.mimeType,
    buffer: Buffer.from(record.contentBase64, 'base64'),
  };
}

export async function softDeleteProxyFileByPublicIdForOwner(
  publicId: string,
  owner: ProxyResourceOwner,
): Promise<boolean> {
  const now = formatUtcSqlDateTime(new Date());
  const result = await db.update(schema.proxyFiles)
    .set({
      deletedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      ownerWhere(owner),
      or(isNull(schema.proxyFiles.deletedAt), eq(schema.proxyFiles.deletedAt, '')),
    ))
    .run();
  return Number(result?.changes || 0) > 0;
}

export async function softDeleteProxyFileByPublicId(
  publicId: string,
  owner: ProxyResourceOwner,
): Promise<boolean> {
  return softDeleteProxyFileByPublicIdForOwner(publicId, owner);
}

export async function softDeleteProxyFile(publicId: string): Promise<boolean> {
  const now = formatUtcSqlDateTime(new Date());
  const result = await db.update(schema.proxyFiles)
    .set({
      deletedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      or(isNull(schema.proxyFiles.deletedAt), eq(schema.proxyFiles.deletedAt, '')),
    ))
    .run();
  return Number(result?.changes || 0) > 0;
}

export async function purgeExpiredProxyFiles(cutoffUtc: string): Promise<number> {
  const normalizedCutoff = cutoffUtc.trim();
  if (!normalizedCutoff) return 0;

  const result = await db.delete(schema.proxyFiles)
    .where(or(
      lt(schema.proxyFiles.createdAt, normalizedCutoff),
      and(isNull(schema.proxyFiles.createdAt), lt(schema.proxyFiles.updatedAt, normalizedCutoff)),
    ))
    .run();

  return Number(result?.changes || 0);
}
