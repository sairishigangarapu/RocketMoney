import React from 'react';
import { api, ApiError, type Room } from './api';

export function ErrorBanner({ err, onDismiss }: { err: unknown; onDismiss: () => void }): React.JSX.Element | null {
  if (!err) return null;
  const msg = err instanceof ApiError ? `Error ${err.status} (${err.code}): ${err.message}` : String(err);
  return (
    <div className="rm-error" role="alert">
      {msg} <button className="rm-btn" onClick={onDismiss} aria-label="Dismiss error">×</button>
    </div>
  );
}

export function RoomsList({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [rooms, setRooms] = React.useState<Room[] | null>(null);
  const [err, setErr] = React.useState<unknown>(null);
  const [name, setName] = React.useState('');
  const [token, setToken] = React.useState('');

  const load = React.useCallback(() => {
    setErr(null);
    api.listRooms().then((r) => setRooms(r.rooms)).catch((e: unknown) => setErr(e));
  }, []);
  React.useEffect(load, [load]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const r = await api.createRoom(name.trim());
      setName('');
      onOpen(r.room.roomId);
    } catch (e2: unknown) {
      setErr(e2);
    }
  }

  async function join(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token.trim()) return;
    try {
      const r = await api.join(token.trim());
      setToken('');
      onOpen(r.roomId);
    } catch (e2: unknown) {
      setErr(e2);
    }
  }

  return (
    <div>
      <ErrorBanner err={err} onDismiss={() => setErr(null)} />
      <section className="rm-card" aria-labelledby="rooms-h">
        <h2 id="rooms-h">My rooms</h2>
        {rooms === null ? (
          <p>Loading…</p>
        ) : rooms.length === 0 ? (
          <p className="rm-note">No rooms yet. Create one below, or paste an invite token to join.</p>
        ) : (
          <div className="rm-grid">
            {rooms.map((r) => (
              <article key={r.roomId} className="rm-card rm-room-card" onClick={() => onOpen(r.roomId)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.roomId); }} tabIndex={0} role="button" aria-label={`Open room ${r.name}`}>
                <h3>{r.name}</h3>
                <div>
                  {r.myRole === 'OWNER' ? <span className="rm-badge owner">Owner</span> : <span className="rm-badge">Member</span>}
                  {r.status === 'FROZEN' && <span className="rm-badge frozen">Frozen</span>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="rm-card" aria-labelledby="create-h">
        <h2 id="create-h">Create room</h2>
        <form className="rm-form" onSubmit={create}>
          <label htmlFor="room-name">Room name</label>
          <input id="room-name" className="rm-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Netflix" maxLength={80} />
          <div><button className="rm-btn primary" type="submit">Create</button></div>
        </form>
      </section>
      <section className="rm-card" aria-labelledby="join-h">
        <h2 id="join-h">Join with invite token</h2>
        <form className="rm-form" onSubmit={join}>
          <label htmlFor="join-token">Invite token</label>
          <input id="join-token" className="rm-input" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token from the room owner" />
          <div><button className="rm-btn primary" type="submit">Join room</button></div>
        </form>
      </section>
    </div>
  );
}
