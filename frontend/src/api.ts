/* Typed API client for the Fastify backend.
 * Auth: the backend's test seam (ALLOW_TEST_AUTH=true + x-test-user header) is a DEV-ONLY
 * stand-in for WorkOS sessions. The user id lives in localStorage so a reviewer can act
 * as owner/member/stranger by switching it. Production login lands with M4c hardening. */

const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getUserId(): string {
  return localStorage.getItem('rm-user') ?? '';
}
export function setUserId(id: string): void {
  localStorage.setItem('rm-user', id);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': getUserId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Room {
  roomId: string;
  name: string;
  ownerId: string;
  status: 'ACTIVE' | 'FROZEN';
  myRole?: 'OWNER' | 'MEMBER';
}
export interface Member {
  roomId: string;
  workosUserId: string;
  role: 'OWNER' | 'MEMBER';
  status: string;
}
export interface Invite {
  token: string;
  roomId: string;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  revoked: boolean;
}
export interface Expense {
  expenseId: string;
  amountMinor: number;
  payerId: string;
  participants: string[];
  shares: Record<string, number>;
  createdAt: string;
}
export interface Settlement {
  settlementId: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  status: 'REQUESTED' | 'COMPLETED' | 'REJECTED';
}
export interface Balances {
  pairs: { pairKey: string; balanceMinor: number }[];
  net: Record<string, number>;
}

export const api = {
  listRooms: () => request<{ rooms: Room[] }>('GET', '/api/rooms'),
  createRoom: (name: string) => request<{ room: Room }>('POST', '/api/rooms', { name }),
  getRoom: (id: string) => request<{ room: Room; role: string }>('GET', `/api/rooms/${id}`),
  listMembers: (id: string) => request<{ members: Member[] }>('GET', `/api/rooms/${id}/members`),
  createInvite: (id: string, maxUses: number) =>
    request<{ invite: Invite }>('POST', `/api/rooms/${id}/invites`, { maxUses }),
  join: (token: string) => request<{ roomId: string; alreadyMember: boolean }>('POST', '/api/join', { token }),
  createExpense: (id: string, e: { amountMinor: number; payerId: string; participants: string[]; idempotencyKey: string }) =>
    request<{ expense: Expense; duplicate: boolean }>('POST', `/api/rooms/${id}/expenses`, e),
  listExpenses: (id: string) => request<{ expenses: Expense[] }>('GET', `/api/rooms/${id}/expenses`),
  getBalances: (id: string) => request<Balances>('GET', `/api/rooms/${id}/balances`),
  rebuild: (id: string) => request<{ match: boolean }>('GET', `/api/rooms/${id}/balances/rebuild`),
  requestSettlement: (id: string, s: { fromId: string; toId: string; amountMinor: number; idempotencyKey: string }) =>
    request<{ settlement: Settlement; duplicate: boolean }>('POST', `/api/rooms/${id}/settlements`, s),
  completeSettlement: (id: string, sid: string) =>
    request<{ settlement: Settlement; duplicate: boolean }>('POST', `/api/rooms/${id}/settlements/${sid}/complete`),
  transfer: (id: string, successorId: string) =>
    request<{ roomId: string; owner: string }>('POST', `/api/rooms/${id}/transfer`, { successorId }),
  removeMember: (id: string, targetId: string) =>
    request<{ removed: string }>('POST', `/api/rooms/${id}/members/remove`, { targetId }),
  claim: (id: string) => request<{ owner: string }>('POST', `/api/rooms/${id}/claim`),
};

export interface Subscription {
  subscriptionId: string;
  ownerId: string;
  roomId?: string;
  provider: string;
  amountMinor: number;
  renewalDate: string;
  status: string;
}
export interface Guide {
  provider: string;
  supported: boolean;
  steps: string[];
  portal: string | null;
}
export interface Dashboard {
  personalMinor: number;
  personalCount: number;
  rooms: { roomId: string; name: string; role: string; status: string; outstandingMinor: number }[];
  totalOutstandingMinor: number;
}

async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-test-user': getUserId() } });
  if (!res.ok) throw new ApiError(res.status, 'download-failed', `HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const subsApi = {
  list: () => request<{ subscriptions: Subscription[] }>('GET', '/api/subscriptions'),
  create: (s: { provider: string; amountMinor: number; renewalDate: string }) =>
    request<{ subscription: Subscription }>('POST', '/api/subscriptions', s),
  link: (id: string, roomId: string) =>
    request<unknown>('POST', `/api/subscriptions/${id}/link`, { roomId }),
  cancel: (id: string) => request<unknown>('POST', `/api/subscriptions/${id}/cancel`),
  guide: (provider: string) => request<Guide>('GET', `/api/guides/${encodeURIComponent(provider)}`),
  concierge: (id: string, authorization: string) =>
    request<unknown>('POST', `/api/subscriptions/${id}/concierge`, { authorization }),
  importCSV: (source: string, batchId: string, csv: string) =>
    request<{ imported: number; skipped: number; total: number }>('POST', '/api/transactions/import', { source, batchId, csv }),
  analyze: () => request<{ subscriptions: { merchant: string; monthlyMinor: number; renewalDate: string }[]; rttMs: number; fallbackUsed: boolean; analyzed: number }>('GET', '/api/analysis'),
  dashboard: () => request<Dashboard>('GET', '/api/dashboard'),
  reportCSV: () => download('/api/reports/burn-rate?format=csv', 'burn-rate.csv'),
  reportPDF: () => download('/api/reports/burn-rate?format=pdf', 'burn-rate.pdf'),
};

/** Minor units <-> display rupees. All money math stays integer in the backend. */
export function toMinor(rupees: string): number {
  const v = Number.parseFloat(rupees);
  if (!Number.isFinite(v) || v <= 0) throw new Error('Enter a positive amount in ₹');
  return Math.round(v * 100);
}
export function toRupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
