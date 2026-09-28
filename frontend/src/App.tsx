import React from 'react';
import { getUserId, setUserId } from './api';
import { RoomsList } from './Rooms';
import { RoomDetail } from './RoomDetail';
import { Subscriptions } from './Subs';
import { Reports } from './Reports';

type View = 'rooms' | 'room' | 'subscriptions' | 'reports';

export default function App(): React.JSX.Element {
  const [view, setView] = React.useState<View>('rooms');
  const [roomId, setRoomId] = React.useState<string | null>(null);
  const [user, setUser] = React.useState<string>(getUserId());

  function openRoom(id: string): void {
    setRoomId(id);
    setView('room');
  }
  function go(v: View): void {
    setView(v);
    if (v !== 'room') setRoomId(null);
  }
  function saveUser(e: React.FormEvent): void {
    e.preventDefault();
    setUserId(user.trim());
  }

  return (
    <div className="rm-shell">
      <header className="rm-header">
        <h1>RocketMoney</h1>
        <nav className="rm-nav" aria-label="Primary">
          <button className="rm-btn" onClick={() => go('rooms')}>Rooms</button>
          <button className="rm-btn" onClick={() => go('subscriptions')}>Subscriptions</button>
          <button className="rm-btn" onClick={() => go('reports')}>Reports</button>
        </nav>
        <form className="rm-userbox" onSubmit={saveUser} title="DEV-ONLY test seam: acts as this WorkOS user id. Production login arrives with M4c.">
          <label htmlFor="rm-user" className="rm-note" style={{ color: 'var(--paper)' }}>Acting as (test):</label>
          <input id="rm-user" className="rm-input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="u-…" />
          <button className="rm-btn" type="submit">Set</button>
        </form>
      </header>
      <main>
        {!user && (
          <div className="rm-error" role="alert">
            Set an acting user id above to talk to the API (dev seam — see title text).
          </div>
        )}
        {view === 'rooms' && <RoomsList onOpen={openRoom} />}
        {view === 'room' && roomId && <RoomDetail roomId={roomId} onBack={() => go('rooms')} />}
        {view === 'subscriptions' && <Subscriptions />}
        {view === 'reports' && <Reports />}
      </main>
      <footer>
        <p className="rm-note">RocketMoney · brutalist build · money in ₹ · API: {(import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000'}</p>
      </footer>
    </div>
  );
}
