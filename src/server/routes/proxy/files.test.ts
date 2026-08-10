import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getProxyResourceOwnerMock = vi.fn();
const saveProxyFileMock = vi.fn();
const listProxyFilesByOwnerMock = vi.fn();
const getProxyFileByPublicIdForOwnerMock = vi.fn();
const getProxyFileContentByPublicIdForOwnerMock = vi.fn();
const softDeleteProxyFileByPublicIdForOwnerMock = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  getProxyResourceOwner: (...args: unknown[]) => getProxyResourceOwnerMock(...args),
}));

vi.mock('../../services/proxyFileStore.js', () => ({
  saveProxyFile: (...args: unknown[]) => saveProxyFileMock(...args),
  listProxyFilesByOwner: (...args: unknown[]) => listProxyFilesByOwnerMock(...args),
  getProxyFileByPublicIdForOwner: (...args: unknown[]) => getProxyFileByPublicIdForOwnerMock(...args),
  getProxyFileContentByPublicIdForOwner: (...args: unknown[]) => getProxyFileContentByPublicIdForOwnerMock(...args),
  softDeleteProxyFileByPublicIdForOwner: (...args: unknown[]) => softDeleteProxyFileByPublicIdForOwnerMock(...args),
}));

function buildUploadBody(boundary: string) {
  return Buffer.from(
    `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="purpose"\r\n\r\n'
      + 'assistants\r\n'
      + `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="sample.pdf"\r\n'
      + 'Content-Type: application/pdf\r\n\r\n'
      + '%PDF-1.7\r\n'
      + `--${boundary}--\r\n`,
  );
}

describe('/v1/files routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { filesProxyRoute } = await import('./files.js');
    app = Fastify();
    await app.register(filesProxyRoute);
  });

  beforeEach(() => {
    getProxyResourceOwnerMock.mockReset();
    saveProxyFileMock.mockReset();
    listProxyFilesByOwnerMock.mockReset();
    getProxyFileByPublicIdForOwnerMock.mockReset();
    getProxyFileContentByPublicIdForOwnerMock.mockReset();
    softDeleteProxyFileByPublicIdForOwnerMock.mockReset();

    getProxyResourceOwnerMock.mockReturnValue({
      ownerType: 'global_proxy_token',
      ownerId: 'global',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('uploads multipart files and returns an OpenAI-style file object', async () => {
    saveProxyFileMock.mockResolvedValue({
      publicId: 'file-metapi-demo',
      purpose: 'assistants',
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      byteSize: 8,
      sha256: 'abc',
      createdAt: '2026-03-08 10:00:00',
      updatedAt: '2026-03-08 10:00:00',
      deletedAt: null,
      contentBase64: Buffer.from('%PDF-1.7').toString('base64'),
      ownerType: 'global_proxy_token',
      ownerId: 'global',
    });

    const boundary = 'metapi-file-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildUploadBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    expect(saveProxyFileMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'global_proxy_token',
      ownerId: 'global',
      purpose: 'assistants',
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      contentBase64: expect.any(String),
    }));
    expect(response.json()).toMatchObject({
      id: 'file-metapi-demo',
      object: 'file',
      filename: 'sample.pdf',
      purpose: 'assistants',
      mime_type: 'application/pdf',
      bytes: 8,
    });
  });

  it('lists files only for the current owner', async () => {
    listProxyFilesByOwnerMock.mockResolvedValue([
      {
        publicId: 'file_abc',
        purpose: 'assistants',
        filename: 'a.json',
        mimeType: 'application/json',
        byteSize: 12,
        sha256: 'abc',
        createdAt: '2026-03-08 10:00:00',
        updatedAt: '2026-03-08 10:00:00',
        deletedAt: null,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/files',
    });

    expect(response.statusCode).toBe(200);
    expect(listProxyFilesByOwnerMock).toHaveBeenCalledWith({ ownerType: 'global_proxy_token', ownerId: 'global' });
    expect(response.json()).toMatchObject({
      object: 'list',
      data: [
        expect.objectContaining({
          id: 'file_abc',
          object: 'file',
        }),
      ],
    });
  });

  it('returns raw content for /v1/files/:id/content', async () => {
    getProxyFileContentByPublicIdForOwnerMock.mockResolvedValue({
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/files/file_pdf/content',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.body).toBe('%PDF-1.7');
  });

  it('soft deletes files and returns deleted=true', async () => {
    softDeleteProxyFileByPublicIdForOwnerMock.mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/files/file_pdf',
    });

    expect(response.statusCode).toBe(200);
    expect(softDeleteProxyFileByPublicIdForOwnerMock).toHaveBeenCalledWith('file_pdf', {
      ownerType: 'global_proxy_token',
      ownerId: 'global',
    });
    expect(response.json()).toEqual({
      id: 'file_pdf',
      object: 'file',
      deleted: true,
    });
  });
});
