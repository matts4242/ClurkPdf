import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, Document, DocumentWithStats } from '../types/index.js';
import { buildPdf, invalidPdfBytes } from './fixtures.js';
import { TEST_UPLOADS_DIR } from './setup.js';

/**
 * End-to-end HTTP tests against a real server instance and a real database.
 *
 * `setup.ts` redirects both the uploads root and DATABASE_URL before any
 * module reads `config`, so this suite never touches development data.
 */

let baseUrl: string;
const uploadsDir = TEST_UPLOADS_DIR;
let close: () => Promise<void>;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;

  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

afterAll(async () => {
  await close?.();
});

async function upload(
  bytes: Buffer,
  filename = 'invoice.pdf',
  type = 'application/pdf',
): Promise<{ status: number; body: ApiResponse<Document> }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  return { status: response.status, body: (await response.json()) as ApiResponse<Document> };
}

/** Poll the document until it leaves `processing`. */
async function waitForStatus(id: string, attempts = 40): Promise<Document> {
  for (let i = 0; i < attempts; i++) {
    const response = await fetch(`${baseUrl}/api/documents/${id}`);
    const body = (await response.json()) as ApiResponse<Document>;
    const document = body.data;
    if (document && document.status !== 'processing') return document;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`document ${id} never left processing`);
}

describe('POST /api/documents/upload', () => {
  it('accepts a PDF and reports its page count', async () => {
    const { status, body } = await upload(buildPdf(['Page one', 'Page two', 'Page three']));

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data?.pageCount).toBe(3);
    expect(body.data?.status).toBe('processing');
    expect(body.data?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('renders page 1 in the background and becomes ready', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;

    const document = await waitForStatus(id);
    expect(document.status).toBe('ready');
    expect(document.thumbnailUrl).toBe(`/uploads/${id}/thumbnail.png`);

    const page = await fs.stat(path.join(uploadsDir, id, 'pages', '1.png'));
    expect(page.size).toBeGreaterThan(0);

    const thumbnail = await fs.readFile(path.join(uploadsDir, id, 'thumbnail.png'));
    // IHDR width lives at byte 16 of a PNG.
    expect(thumbnail.readUInt32BE(16)).toBe(150);
  });

  it('rejects a non-PDF with INVALID_FILE_TYPE', async () => {
    const { status, body } = await upload(Buffer.from('plain text'), 'notes.txt', 'text/plain');

    expect(status).toBe(415);
    expect(body.error?.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects an unparseable PDF with INVALID_PDF and stores nothing', async () => {
    const before = await fs.readdir(uploadsDir);
    const { status, body } = await upload(invalidPdfBytes);

    expect(status).toBe(422);
    expect(body.error?.code).toBe('INVALID_PDF');
    expect(await fs.readdir(uploadsDir)).toEqual(before);
  });

  it('rejects a request with no file', async () => {
    const response = await fetch(`${baseUrl}/api/documents/upload`, {
      method: 'POST',
      body: new FormData(),
    });
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe('NO_FILE_UPLOADED');
  });
});

describe('GET /api/documents/:id', () => {
  it('returns 400 for a malformed id', async () => {
    const response = await fetch(`${baseUrl}/api/documents/not-a-uuid`);
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_REQUEST');
  });

  it('returns 404 for an unknown id', async () => {
    const response = await fetch(
      `${baseUrl}/api/documents/11111111-1111-4111-8111-111111111111`,
    );
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('GET /api/documents/:id/pages/:pageNumber', () => {
  it('renders a page on demand and caches it to disk', async () => {
    const { body } = await upload(buildPdf(['First', 'Second']));
    const id = body.data!.id;
    await waitForStatus(id);

    const pagePath = path.join(uploadsDir, id, 'pages', '2.png');
    await expect(fs.stat(pagePath)).rejects.toThrow();

    const response = await fetch(`${baseUrl}/api/documents/${id}/pages/2`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');

    const bytes = Buffer.from(await response.arrayBuffer());
    // PNG magic number.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await fs.stat(pagePath)).size).toBe(bytes.length);
  });

  it('returns 404 for a page past the end of the document', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;
    await waitForStatus(id);

    const response = await fetch(`${baseUrl}/api/documents/${id}/pages/9`);
    const payload = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(404);
    expect(payload.error?.code).toBe('PAGE_NOT_FOUND');
  });

  it('rejects a non-numeric page number', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;

    const response = await fetch(`${baseUrl}/api/documents/${id}/pages/abc`);
    expect(response.status).toBe(400);
  });
});

describe('/uploads static serving', () => {
  it('serves rendered page images', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;
    await waitForStatus(id);

    for (const suffix of ['pages/1.png', 'thumbnail.png']) {
      const response = await fetch(`${baseUrl}/uploads/${id}/${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/png');
    }
  });

  it('refuses the original PDF and the metadata sidecar', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;
    await waitForStatus(id);

    for (const suffix of ['original.pdf', 'document.json']) {
      const response = await fetch(`${baseUrl}/uploads/${id}/${suffix}`);
      expect(response.status).toBe(403);
    }
  });
});

describe('DELETE /api/documents/:id', () => {
  it('removes the document directory', async () => {
    const { body } = await upload(buildPdf(['Only page']));
    const id = body.data!.id;
    await waitForStatus(id);

    const response = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);

    await expect(fs.stat(path.join(uploadsDir, id))).rejects.toThrow();
    expect((await fetch(`${baseUrl}/api/documents/${id}`)).status).toBe(404);
  });
});
