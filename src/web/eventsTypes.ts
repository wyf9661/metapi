/**
 * Shared contract for the events API (program logs / announcements).
 * Single source of truth for the `/api/events` list response so the web
 * client does not rely on `Record<string, unknown>`.
 */
export type ProgramEvent = {
  id: number;
  type: string;
  title: string;
  message?: string | null;
  level: 'info' | 'warning' | 'error';
  read: boolean;
  relatedId?: number | null;
  relatedType?: string | null;
  createdAt?: string | null;
};

export type EventsListResponse = {
  items: ProgramEvent[];
  total: number;
};
