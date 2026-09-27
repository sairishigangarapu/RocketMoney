import React from 'react';

/** M0 placeholder. Brutalist token set + real views land in M3/M4 (ADR-009). */
export default function App(): React.JSX.Element {
  return (
    <main
      style={{
        fontFamily: 'monospace',
        border: '4px solid #000',
        padding: 24,
        maxWidth: 720,
        margin: '32px auto',
      }}
    >
      <h1 style={{ textTransform: 'uppercase', letterSpacing: 2 }}>RocketMoney</h1>
      <p>M0 skeleton — subscription auditor + shared rooms. UI arrives in M4.</p>
    </main>
  );
}
