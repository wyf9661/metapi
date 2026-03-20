function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function splitBase64DataUrl(value: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) return null;
  return {
    mimeType: match[1].trim().toLowerCase(),
    data: match[2].trim(),
  };
}

function normalizeFileSourceSelection(
  fileData: string,
  fileUrl: string,
  fileId: string,
): { fileData: string; fileUrl: string; fileId: string } {
  if (fileData) {
    return { fileData, fileUrl: '', fileId: '' };
  }
  if (fileUrl) {
    return { fileData: '', fileUrl, fileId: '' };
  }
  return { fileData: '', fileUrl: '', fileId };
}

export function ensureBase64DataUrl(fileData: string, mimeType?: string | null): string {
  const trimmedData = asTrimmedString(fileData);
  if (!trimmedData) return trimmedData;
  if (splitBase64DataUrl(trimmedData)) return trimmedData;

  const normalizedMimeType = asTrimmedString(mimeType).toLowerCase();
  if (!normalizedMimeType) return trimmedData;
  return `data:${normalizedMimeType};base64,${trimmedData}`;
}

export type NormalizedInputFile = {
  sourceType?: 'file' | 'input_file';
  fileId?: string;
  fileData?: string;
  fileUrl?: string;
  filename?: string;
  mimeType?: string | null;
  hadDataUrl?: boolean;
};

export function inferInputFileMimeType(input: Pick<NormalizedInputFile, 'filename' | 'mimeType'>): string | null {
  const explicit = asTrimmedString(input.mimeType);
  if (explicit) return explicit.toLowerCase();

  const filename = asTrimmedString(input.filename).toLowerCase();
  if (!filename) return null;
  if (filename.endsWith('.pdf')) return 'application/pdf';
  if (filename.endsWith('.txt')) return 'text/plain';
  if (filename.endsWith('.md') || filename.endsWith('.markdown')) return 'text/markdown';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
  if (filename.endsWith('.gif')) return 'image/gif';
  if (filename.endsWith('.webp')) return 'image/webp';
  if (filename.endsWith('.wav')) return 'audio/wav';
  if (filename.endsWith('.mp3')) return 'audio/mpeg';
  return null;
}

export function normalizeInputFileBlock(item: Record<string, unknown>): NormalizedInputFile | null {
  const type = asTrimmedString(item.type).toLowerCase();

  if (type === 'input_file') {
    const selectedSource = normalizeFileSourceSelection(
      asTrimmedString(item.file_data),
      asTrimmedString(item.file_url),
      asTrimmedString(item.file_id),
    );
    const fileId = selectedSource.fileId;
    const fileData = selectedSource.fileData;
    const fileUrl = selectedSource.fileUrl;
    const filename = asTrimmedString(item.filename);
    let mimeType = asTrimmedString(item.mime_type ?? item.mimeType) || null;
    if (!fileId && !fileData && !fileUrl) return null;
    const parsedDataUrl = fileData ? splitBase64DataUrl(fileData) : null;
    if (parsedDataUrl) {
      mimeType = mimeType || parsedDataUrl.mimeType;
    }
    return {
      sourceType: 'input_file',
      fileId: fileId || undefined,
      fileData: fileData || undefined,
      fileUrl: fileUrl || undefined,
      filename: filename || undefined,
      mimeType,
      hadDataUrl: /^data:[^;,]+;base64,/i.test(fileData),
    };
  }

  if (type === 'file') {
    const file = isRecord(item.file) ? item.file : item;
    const selectedSource = normalizeFileSourceSelection(
      asTrimmedString(file.file_data ?? item.file_data),
      asTrimmedString(file.file_url ?? item.file_url),
      asTrimmedString(file.file_id ?? item.file_id),
    );
    const fileId = selectedSource.fileId;
    const fileData = selectedSource.fileData;
    const fileUrl = selectedSource.fileUrl;
    const filename = asTrimmedString(file.filename ?? item.filename);
    let mimeType = asTrimmedString(file.mime_type ?? file.mimeType ?? item.mime_type ?? item.mimeType) || null;
    if (!fileId && !fileData && !fileUrl) return null;
    const parsedDataUrl = fileData ? splitBase64DataUrl(fileData) : null;
    if (parsedDataUrl) {
      mimeType = mimeType || parsedDataUrl.mimeType;
    }
    return {
      sourceType: 'file',
      fileId: fileId || undefined,
      fileData: fileData || undefined,
      fileUrl: fileUrl || undefined,
      filename: filename || undefined,
      mimeType,
      hadDataUrl: /^data:[^;,]+;base64,/i.test(fileData),
    };
  }

  return null;
}

export function toResponsesInputFileBlock(file: NormalizedInputFile): Record<string, unknown> {
  const parsedDataUrl = file.fileData ? splitBase64DataUrl(file.fileData) : null;
  const block: Record<string, unknown> = { type: 'input_file' };
  if (file.fileData) {
    block.file_data = ensureBase64DataUrl(
      file.fileData,
      parsedDataUrl?.mimeType || inferInputFileMimeType(file),
    );
  }
  if (file.fileUrl && !block.file_data) block.file_url = file.fileUrl;
  if (file.fileId && !block.file_data && !block.file_url) block.file_id = file.fileId;
  if (file.filename) block.filename = file.filename;
  return block;
}

export function toOpenAiChatFileBlock(file: NormalizedInputFile): Record<string, unknown> {
  const parsedDataUrl = file.fileData ? splitBase64DataUrl(file.fileData) : null;
  const payload: Record<string, unknown> = {};
  if (file.fileData) payload.file_data = parsedDataUrl?.data || file.fileData;
  else if (file.fileUrl) payload.file_url = file.fileUrl;
  else if (file.fileId) payload.file_id = file.fileId;
  if (file.filename) payload.filename = file.filename;
  if (file.mimeType) payload.mime_type = file.mimeType;
  else if (parsedDataUrl?.mimeType) payload.mime_type = parsedDataUrl.mimeType;
  const block: Record<string, unknown> = { type: 'file' };
  block.file = payload;
  return block;
}

export function toAnthropicDocumentBlock(file: NormalizedInputFile): Record<string, unknown> | null {
  if (file.fileUrl) {
    return {
      type: 'document',
      source: {
        type: 'url',
        url: file.fileUrl,
      },
      ...(file.filename ? { title: file.filename } : {}),
    };
  }
  if (!file.fileData) return null;
  const parsedDataUrl = splitBase64DataUrl(file.fileData);
  const mimeType = parsedDataUrl?.mimeType || inferInputFileMimeType(file);
  if (!mimeType) return null;
  return {
    type: 'document',
    ...(file.hadDataUrl ? { cache_control: { type: 'ephemeral' } } : {}),
    source: {
      type: 'base64',
      media_type: mimeType,
      data: parsedDataUrl?.data || file.fileData,
    },
    ...(file.filename ? { title: file.filename } : {}),
  };
}
