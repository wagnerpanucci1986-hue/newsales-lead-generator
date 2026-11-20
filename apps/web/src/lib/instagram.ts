export interface InstagramConnection {
  igUserId: string;
  igUsername: string;
  pageName: string | null;
  connectedAt: string;
}

export interface InstagramProfile {
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  followersCount: number | null;
  mediaCount: number | null;
  lastPostAt: string | null;
  phones: string[];
  emails: string[];
  error: string | null;
  fetchedAt: string;
}

export interface LookupResponse {
  profiles: InstagramProfile[];
  pending: string[];
  stopReason: string | null;
  invalid: string[];
}

export const compactNumber = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }));
