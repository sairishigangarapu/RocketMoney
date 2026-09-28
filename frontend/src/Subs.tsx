import React from 'react';
import { subsApi, api, toMinor, toRupees, type Subscription } from './api';
import { ErrorBanner } from './Rooms';

export function Subscriptions(): React.JSX.Element {
  const [subs, setSubs] = React.useState<Subscription[] | null>(null);
  const [rooms, setRooms] = React.useState<{ roomId: string; name: string }[]>([]);
  const [err, setErr] = React.useState<unknown>(null);
  const [form, setForm] = React.useState({ provider: '', amount: '', renewalDate: '' });
  const [guide, setGuide] = React.useState<{ provider: string; steps: string[]; portal: string | null; supported: boolean } | null>(null);

  const load = React.useCallback(() => {
    setErr(null);
    Promise.all([subsApi.list(), api.listRooms()])
      .then(([s, r]) => {
        setSubs(s.subscriptions);
        setRooms(r.rooms.filter((x) => x.myRole === 'OWNER').map((x) => ({ roomId: x.roomId, name: x.name })));
      })
      .catch((e: unknown) => setErr(e));
  }, []);
  React.useEffect(load, [load]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    let minor = 0;
    try {
      minor = toMinor(form.amount);
    } catch (e2: unknown) {
      setErr(e2);
      return;
    }
    try {
      await subsApi.create({ provider: form.provider.trim(), amountMinor: minor, renewalDate: form.renewalDate });
      setForm({ provider: '', amount: '', renewalDate: '' });
      load();
    } catch (e2: unknown) {
      setErr(e2);
    }
  }

  async function showGuide(provider: string): Promise<void> {
    try {
      setGuide(await subsApi.guide(provider));
    } catch (e: unknown) {
      setErr(e);
    }
  }

  return (
    <div>
      <ErrorBanner err={err} onDismiss={() => setErr(null)} />
      <section className="rm-card" aria-labelledby="subs-h">
        <h2 id="subs-h">My subscriptions</h2>
        {subs === null ? <p>Loading…</p> : subs.length === 0 ? <p className="rm-note">None tracked. Add one below or import transactions on the Reports tab to detect them.</p> : (
          <table className="rm-table">
            <thead><tr><th scope="col">Provider</th><th scope="col">Monthly</th><th scope="col">Renews</th><th scope="col">Shared</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.subscriptionId}>
                  <td>{s.provider}</td>
                  <td className="num">{toRupees(s.amountMinor)}</td>
                  <td>{s.renewalDate}</td>
                  <td>{s.roomId ? 'Yes' : 'Personal'}</td>
                  <td>
                    <button className="rm-btn" onClick={() => void showGuide(s.provider)}>Guide</button>{' '}
                    {!s.roomId && rooms.length > 0 && (
                      <select className="rm-select" style={{ width: 'auto' }} defaultValue="" aria-label={`Share ${s.provider} to room`}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          subsApi.link(s.subscriptionId, e.target.value).then(load).catch((e2: unknown) => setErr(e2));
                        }}>
                        <option value="">Share to…</option>
                        {rooms.map((r) => <option key={r.roomId} value={r.roomId}>{r.name}</option>)}
                      </select>
                    )}{' '}
                    <button className="rm-btn danger" onClick={() => {
                      if (window.confirm(`Mark ${s.provider} cancelled?`)) {
                        subsApi.cancel(s.subscriptionId).then(load).catch((e: unknown) => setErr(e));
                      }
                    }}>Cancel</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {guide && (
          <div className="rm-card" style={{ boxShadow: 'none' }}>
            <h3>Cancellation: {guide.provider}</h3>
            {!guide.supported ? <p className="rm-note">No guide for this provider yet.</p> : (
              <><ol>{guide.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
              {guide.portal && <p><a href={guide.portal} target="_blank" rel="noreferrer">Official cancellation portal</a></p>}</>
            )}
          </div>
        )}
      </section>
      <section className="rm-card" aria-labelledby="addsub-h">
        <h2 id="addsub-h">Track subscription</h2>
        <form className="rm-form" onSubmit={create}>
          <label htmlFor="sub-provider">Provider</label>
          <input id="sub-provider" className="rm-input" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="Netflix" />
          <label htmlFor="sub-amount">Monthly amount (₹)</label>
          <input id="sub-amount" className="rm-input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="649.00" inputMode="decimal" />
          <label htmlFor="sub-renew">Next renewal date</label>
          <input id="sub-renew" className="rm-input" type="date" value={form.renewalDate} onChange={(e) => setForm({ ...form, renewalDate: e.target.value })} />
          <div><button className="rm-btn primary" type="submit">Track</button></div>
        </form>
      </section>
    </div>
  );
}
