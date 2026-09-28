import React from 'react';
import { subsApi, toRupees, type Dashboard } from './api';
import { ErrorBanner } from './Rooms';

export function Reports(): React.JSX.Element {
  const [dash, setDash] = React.useState<Dashboard | null>(null);
  const [analysis, setAnalysis] = React.useState<{ analyzed: number; rttMs: number; fallbackUsed: boolean } | null>(null);
  const [found, setFound] = React.useState<{ merchant: string; monthlyMinor: number; renewalDate: string }[]>([]);
  const [err, setErr] = React.useState<unknown>(null);
  const [csv, setCsv] = React.useState('date,merchant,amount\n2026-06-05,Netflix,649.00\n2026-07-05,Netflix,649.00\n2026-08-05,Netflix,649.00\n');
  const [importResult, setImportResult] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    subsApi.dashboard().then(setDash).catch((e: unknown) => setErr(e));
  }, []);
  React.useEffect(load, [load]);

  async function runAnalysis(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      const batch = `ui-${Date.now()}`;
      const r = await subsApi.importCSV('CSV', batch, csv);
      setImportResult(`Imported ${r.imported}, skipped ${r.skipped} of ${r.total} (re-uploads skip).`);
      const a = await subsApi.analyze();
      setFound(a.subscriptions);
      setAnalysis({ analyzed: a.analyzed, rttMs: a.rttMs, fallbackUsed: a.fallbackUsed });
    } catch (e2: unknown) {
      setErr(e2);
    }
  }

  return (
    <div>
      <ErrorBanner err={err} onDismiss={() => setErr(null)} />
      <section className="rm-card" aria-labelledby="dash-h">
        <h2 id="dash-h">Burn-rate dashboard</h2>
        {!dash ? <p>Loading…</p> : (
          <>
            <p>Personal active subscriptions: <strong>{dash.personalCount}</strong> → <strong>{toRupees(dash.personalMinor)}/mo</strong></p>
            <p>Total outstanding room balances: <strong>{toRupees(dash.totalOutstandingMinor)}</strong></p>
            {dash.rooms.length > 0 && (
              <table className="rm-table">
                <thead><tr><th scope="col">Room</th><th scope="col">Role</th><th scope="col">Outstanding</th></tr></thead>
                <tbody>
                  {dash.rooms.map((r) => (
                    <tr key={r.roomId}><td>{r.name}</td><td>{r.role}</td><td className="num">{toRupees(r.outstandingMinor)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
      <section className="rm-card" aria-labelledby="det-h">
        <h2 id="det-h">Detect recurring charges</h2>
        <form className="rm-form" onSubmit={runAnalysis}>
          <label htmlFor="csv-in">Transactions CSV (date,merchant,amount)</label>
          <textarea id="csv-in" className="rm-input" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
          <div><button className="rm-btn primary" type="submit">Import + analyze</button></div>
        </form>
        {importResult && <p className="rm-note">{importResult}</p>}
        {analysis && (
          <p className="rm-note">Analyzed {analysis.analyzed} rows in {analysis.rttMs} ms ({analysis.fallbackUsed ? 'deterministic fallback' : 'SkillOpt'}).</p>
        )}
        {found.length > 0 && (
          <table className="rm-table">
            <thead><tr><th scope="col">Merchant</th><th scope="col">Monthly</th><th scope="col">Next renewal</th></tr></thead>
            <tbody>
              {found.map((f) => (
                <tr key={f.merchant}><td>{f.merchant}</td><td className="num">{toRupees(f.monthlyMinor)}</td><td>{f.renewalDate}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="rm-card" aria-labelledby="rep-h">
        <h2 id="rep-h">Anonymized aggregate reports</h2>
        <p className="rm-note">Provider totals only. No names, emails, or user ids.</p>
        <button className="rm-btn primary" onClick={() => subsApi.reportCSV().catch((e: unknown) => setErr(e))}>Download CSV</button>{' '}
        <button className="rm-btn primary" onClick={() => subsApi.reportPDF().catch((e: unknown) => setErr(e))}>Download PDF</button>
      </section>
    </div>
  );
}
