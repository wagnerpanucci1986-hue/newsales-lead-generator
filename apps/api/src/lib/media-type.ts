import { MessageType } from '@prisma/client';

/** Como o WhatsApp vai tratar um anexo, pelo tipo do arquivo. */
export function messageTypeForMime(mime: string): MessageType {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return MessageType.IMAGE;
  if (mime === 'video/mp4') return MessageType.VIDEO;
  if (mime.startsWith('audio/')) return MessageType.AUDIO;
  return MessageType.DOCUMENT;
}

export const MEDIA_PREVIEW_LABEL: Partial<Record<MessageType, string>> = {
  IMAGE: '📷 Imagem',
  VIDEO: '🎥 Vídeo',
  AUDIO: '🎤 Áudio',
  DOCUMENT: '📄 Documento',
};
