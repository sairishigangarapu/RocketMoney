import React from 'react';
import { api, ApiError, toMinor, toRupees, shortId, getUserId, type Member, type Expense } from './api';
import { ErrorBanner } from './Rooms';

function useRoomData(roomId: string, refreshToken: number) {
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [expenses, setExpenses] = React.useState<Expense[] | null>(null);
  const [balances, setBalances] = React.useState<{ pairs: { pairKey: string; balanceMinor: number }[]; net: Record<string, number> } | null>(null);
  const [room, setRoom] = React.useState<{ name: string; status: string; ownerId: string; myRole?: string } | null>(null);
  const [err, setErr] = React.useState<unknown>(null);
  React.useEffect(() => {
    setErr(null);
    Promise.all([api.getRoom(roomId), api.listMembers(roomId), api.listExpenses(roomId), api.getBalances(roomId)])
      .then(([r, m, e, b]) => {
        setRoom({ ...r.room, myRole: r.role });
        setMembers(m.members);
        setExpenses(e.expenses);
        setBalances(b);
      })
      .catch((e: unknown) => setErr(e));
  }, [roomId, refreshToken]);
  return { room, members, expenses, balances, err, setErr };
}

export function RoomDetail({ roomId, onBack }: { roomId: string; onBack: () => void }): React.JSX.Element {
  const [tick, setTick] = React.useState(0);
  const { room, members, expenses, balances, err, setErr } = useRoomData(roomId, tick);
  const [invite, setInvite] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState('');
  const [payer, setPayer] = React.useState('');
  const [picked, setPicked] = React.useState<string[]>([]);
  const [settle, setSettle] = React.useState({ from: '', to: '', amount: '' });
  const [successor, setSuccessor] = React.useState('');
  const me = getUserId();
  const refresh = (): void => setTick((t) => t + 1);
  const isOwner = room?.myRole === 'OWNER';
  const frozen = room?.status === 'FROZEN';

  React.useEffect(() => {
    if (members && members.length > 0 && !payer) {
      setPayer(members[0].workosUserId);
      setPicked(members.map((m) => m.workosUserId));
    }
  }, [members, payer]);

  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const r = await fn();
      refresh();
      return r;
    } catch (e: unknown) {
      setErr(e);
      return undefined;
    }
  }

  async function addExpense(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    let minor = 0;
    try {
      minor = toMinor(amount);
    } catch (e2: unknown) {
      setErr(e2);
      return;
    }
    await guard(() => api.createExpense(roomId, {
      amountMinor: minor, payerId: payer, participants: picked,
      idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    setAmount('');
  }

  async function doSettle(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    let minor = 0;
    try {
      minor = toMinor(settle.amount);
    } catch (e2: unknown) {
      setErr(e2);
      return;
    }
    const r = await guard(() => api.requestSettlement(roomId, {
      fromId: settle.from, toId: settle.to, amountMinor: minor,
      idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    if (r && !r.duplicate && window.confirm(`Complete settlement of ${toRupees(minor)} from ${shortId(settle.from)} to ${shortId(settle.to)} now?`)) {
      await guard(() => api.completeSettlement(roomId, r.settlement.settlementId));
    }
    setSettle({ from: '', to: '', amount: '' });
  }

  if (err && !room) {
    const code = err instanceof ApiError ? err.status : '';
    return (
      <div>
        <button className="rm-btn" onClick={onBack}>← Rooms</button>
        <div className="rm-card" style={{ marginTop: 16 }}>
          <h2>{code === 404 ? 'Room not found' : 'Cannot open room'}</h2>
          <p className="rm-note">{code === 404 ? 'It may not exist, or you are not a member.' : String(err)}</p>
        </div>
      </div>
    );
  }
  if (!room || !members || !expenses || !balances) return <p>Loading…</p>;

  const spend = expenses.reduce((s, e) => s + e.amountMinor, 0);
  const togglePick = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div>
      <button className="rm-btn" onClick={onBack}>← Rooms</button>
      <div style={{ marginTop: 16 }} className="rm-card">
        <h2>{room.name}</h2>
        <div>
          {isOwner ? <span className="rm-badge owner">You are owner</span> : <span className="rm-badge">You are member</span>}
          {frozen && <span className="rm-badge frozen">Frozen — writes blocked</span>}
        </div>
        <p>Recorded shared spend: <strong>{toRupees(spend)}</strong> across {expenses.length} expense(s).</p>
      </div>
      {frozen && (
        <div className="rm-frozen-banner" role="alert">
          Frozen: the owner departed without a successor. Reads work; writes are rejected.
          {members.some((m) => m.workosUserId === me) && (
            <> <button className="rm-btn" onClick={() => guard(() => api.claim(roomId))}>Claim ownership</button></>
          )}
        </div>
      )}
      <ErrorBanner err={err} onDismiss={() => setErr(null)} />

      <section className="rm-card" aria-labelledby="mem-h">
        <h2 id="mem-h">Members ({members.length})</h2>
        <table className="rm-table">
          <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Net balance</th><th scope="col">Action</th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.workosUserId}>
                <td>{shortId(m.workosUserId)}{m.workosUserId === me ? ' (you)' : ''}</td>
                <td>{m.role}</td>
                <td className="num">{toRupees(balances.net[m.workosUserId] ?? 0)}</td>
                <td>
                  {isOwner && m.role !== 'OWNER' && (
                    <button className="rm-btn danger" onClick={() => {
                      if (window.confirm(`Remove ${shortId(m.workosUserId)}? Blocked while they hold a balance.`)) {
                        void guard(() => api.removeMember(roomId, m.workosUserId));
                      }
                    }}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isOwner && !frozen && (
        <section className="rm-card" aria-labelledby="inv-h">
          <h2 id="inv-h">Invite members</h2>
          <button className="rm-btn primary" onClick={() => guard(async () => {
            const r = await api.createInvite(roomId, 5);
            setInvite(r.invite.token);
            return r;
          })}>Generate token (5 uses, 7 days)</button>
          {invite && (
            <p>Token: <strong style={{ wordBreak: 'break-all' }}>{invite}</strong>
              {' '}<button className="rm-btn" onClick={() => { void navigator.clipboard?.writeText(invite); }}>Copy</button></p>
          )}
          <p className="rm-note">Share it privately. Anyone with the link joins after WorkOS sign-in.</p>
        </section>
      )}

      {!frozen && (
        <section className="rm-card" aria-labelledby="exp-h">
          <h2 id="exp-h">Record expense (equal split)</h2>
          <form className="rm-form" onSubmit={addExpense}>
            <label htmlFor="exp-amount">Amount (₹)</label>
            <input id="exp-amount" className="rm-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000.00" inputMode="decimal" />
            <label htmlFor="exp-payer">Paid by</label>
            <select id="exp-payer" className="rm-select" value={payer} onChange={(e) => setPayer(e.target.value)}>
              {members.map((m) => <option key={m.workosUserId} value={m.workosUserId}>{shortId(m.workosUserId)}</option>)}
            </select>
            <span id="exp-part-label" className="rm-note">Split among (payer must be included):</span>
            <div className="rm-checkrow" role="group" aria-labelledby="exp-part-label">
              {members.map((m) => (
                <label key={m.workosUserId} className="rm-check">
                  <input type="checkbox" checked={picked.includes(m.workosUserId)} onChange={() => togglePick(m.workosUserId)} />
                  {shortId(m.workosUserId)}
                </label>
              ))}
            </div>
            <div><button className="rm-btn primary" type="submit">Add expense</button></div>
          </form>
        </section>
      )}

      <section className="rm-card" aria-labelledby="exps-h">
        <h2 id="exps-h">Expenses</h2>
        {expenses.length === 0 ? <p className="rm-note">None yet.</p> : (
          <table className="rm-table">
            <thead><tr><th scope="col">When</th><th scope="col">Payer</th><th scope="col">Amount</th><th scope="col">Each</th></tr></thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.expenseId}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{shortId(e.payerId)}</td>
                  <td className="num">{toRupees(e.amountMinor)}</td>
                  <td className="num">{toRupees(e.shares[e.payerId] ?? 0)} × {e.participants.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rm-card" aria-labelledby="bal-h">
        <h2 id="bal-h">Balances</h2>
        {balances.pairs.length === 0 ? <p className="rm-note">Settled up.</p> : (
          <table className="rm-table">
            <thead><tr><th scope="col">Pair</th><th scope="col">Owes</th></tr></thead>
            <tbody>
              {balances.pairs.map((p) => {
                const [a, b] = p.pairKey.split('#');
                return (
                  <tr key={p.pairKey}>
                    <td>{shortId(a)} ↔ {shortId(b)}</td>
                    <td className="num">{p.balanceMinor > 0 ? `${shortId(a)} owes ${toRupees(p.balanceMinor)}` : `${shortId(b)} owes ${toRupees(-p.balanceMinor)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {!frozen && (
        <section className="rm-card" aria-labelledby="stl-h">
          <h2 id="stl-h">Settle up</h2>
          <form className="rm-form" onSubmit={doSettle}>
            <label htmlFor="stl-from">From (pays)</label>
            <select id="stl-from" className="rm-select" value={settle.from} onChange={(e) => setSettle({ ...settle, from: e.target.value })}>
              <option value="">—</option>
              {members.map((m) => <option key={m.workosUserId} value={m.workosUserId}>{shortId(m.workosUserId)}</option>)}
            </select>
            <label htmlFor="stl-to">To (receives)</label>
            <select id="stl-to" className="rm-select" value={settle.to} onChange={(e) => setSettle({ ...settle, to: e.target.value })}>
              <option value="">—</option>
              {members.map((m) => <option key={m.workosUserId} value={m.workosUserId}>{shortId(m.workosUserId)}</option>)}
            </select>
            <label htmlFor="stl-amount">Amount (₹)</label>
            <input id="stl-amount" className="rm-input" value={settle.amount} onChange={(e) => setSettle({ ...settle, amount: e.target.value })} placeholder="200.00" inputMode="decimal" />
            <div><button className="rm-btn primary" type="submit">Request + complete</button></div>
          </form>
        </section>
      )}

      {isOwner && !frozen && (
        <section className="rm-card" aria-labelledby="dz-h">
          <h2 id="dz-h">Danger zone</h2>
          <form className="rm-form" onSubmit={(e) => {
            e.preventDefault();
            if (successor && window.confirm(`Transfer ownership to ${shortId(successor)}? You become a member.`)) {
              void guard(() => api.transfer(roomId, successor));
            }
          }}>
            <label htmlFor="dz-succ">Transfer ownership (required before you can leave)</label>
            <select id="dz-succ" className="rm-select" value={successor} onChange={(e) => setSuccessor(e.target.value)}>
              <option value="">—</option>
              {members.filter((m) => m.role !== 'OWNER').map((m) => (
                <option key={m.workosUserId} value={m.workosUserId}>{shortId(m.workosUserId)}</option>
              ))}
            </select>
            <div><button className="rm-btn danger" type="submit">Transfer</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
