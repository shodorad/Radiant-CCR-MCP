/**
 * The CCR client. Reads only what the repository publishes about itself
 * (/ccr/records, /ccr/record?view=public), never Drupal field names or JSON:API.
 * The translation from Drupal to the neutral record belongs to the repository
 * (RecordNormaliser.php); a channel that re-did it would drift from it.
 */

export const RECORD_TYPES = ['company_overview', 'case_study'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface Listing {
  id: string;
  nid: number;
  type: RecordType;
  title: string;
  /** Unix seconds from Drupal; an ISO string in the hand-written fixtures. */
  changed: number | string;
  summary: string;
  fictional: boolean;
}

export interface Pillar {
  key: string;
  weight: number;
  name: string | null;
  description: string | null;
  icon_token?: string | null;
}

export interface CcrRecord {
  id: string;
  nid: number;
  type: RecordType;
  title: string;
  changed: number | string;
  fictional?: boolean;
  // company_overview
  positioning_statement?: string | null;
  framework_name?: string | null;
  framework_statement?: string | null;
  capability_pillars?: Pillar[];
  // case_study
  client_name?: string | null;
  source_material?: string | null;
  withheld?: string[];
}

export class CcrError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface CcrClient {
  baseUrl: string;
  listRecords(type?: RecordType): Promise<Listing[]>;
  getRecord(nid: number): Promise<CcrRecord>;
}

export function ccrClient(baseUrl: string, fetchImpl: typeof fetch = fetch): CcrClient {
  const base = baseUrl.replace(/\/$/, '');

  async function get<T>(path: string): Promise<T> {
    const url = `${base}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new CcrError(`the content repository could not be reached (${(e as Error).message})`, 502);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new CcrError(body.error ?? `the content repository answered ${res.status}`, res.status);
    return body as T;
  }

  return {
    baseUrl: base,
    async listRecords(type) {
      const { records } = await get<{ records: Listing[] }>(`/ccr/records${type ? `?type=${encodeURIComponent(type)}` : ''}`);
      return records;
    },
    getRecord(nid) {
      return get<CcrRecord>(`/ccr/record?nid=${encodeURIComponent(String(nid))}&view=public`);
    },
  };
}
