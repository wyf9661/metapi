export const CONVERSATION_DOCUMENT_ACCEPT_PARTS = ['.pdf', '.txt', '.md', '.markdown', '.json'];
const DOCUMENT_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'text/markdown',
  'text/plain',
]);
const DOCUMENT_EXTENSIONS = ['.json', '.md', '.markdown', '.pdf', '.txt'];
const IMAGE_EXTENSIONS = ['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'];
const AUDIO_EXTENSIONS = ['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.weba'];

function normalizeValue(value) {
  return (value || '').trim().toLowerCase();
}

export function classifyConversationFileMimeType(mimeType) {
  const normalized = normalizeValue(mimeType);
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  return 'document';
}

export function detectConversationFileKind(file) {
  const mimeType = normalizeValue(file?.mimeType);
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (DOCUMENT_MIME_TYPES.has(mimeType)) return 'document';
  }

  const filename = normalizeValue(file?.filename);
  if (!filename) return 'unknown';
  if (DOCUMENT_EXTENSIONS.some((extension) => filename.endsWith(extension))) return 'document';
  if (IMAGE_EXTENSIONS.some((extension) => filename.endsWith(extension))) return 'image';
  if (AUDIO_EXTENSIONS.some((extension) => filename.endsWith(extension))) return 'audio';
  return 'unknown';
}

export function isSupportedConversationFileMimeType(mimeType) {
  const normalized = normalizeValue(mimeType);
  return DOCUMENT_MIME_TYPES.has(normalized)
    || normalized.startsWith('image/')
    || normalized.startsWith('audio/');
}

export function buildConversationAcceptList(input) {
  const parts = [];
  if (input.document) parts.push(...CONVERSATION_DOCUMENT_ACCEPT_PARTS);
  if (input.image) parts.push('image/*');
  if (input.audio) parts.push('audio/*');
  return parts.join(',');
}
