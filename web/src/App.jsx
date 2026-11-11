import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz } from 'ag-grid-community';

// Which data the app shows: 'demo' (built-in cases) or 'sandbox' (live PayPal sandbox).
let SOURCE = null;
const sourceQS = () => (SOURCE ? `source=${SOURCE}` : '');
const withSource = (url) => (SOURCE ? `${url}${url.includes('?') ? '&' : '?'}${sourceQS()}` : url);

const api = (path, opts = {}) =>
  fetch(`/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(SOURCE ? { 'X-Data-Source': SOURCE } : {}), ...(opts.headers || {}) } }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || (r.status >= 500 && !j.error ? "The DisputeShield server isn't responding. Check the terminal where you ran npm start." : `Request failed (${r.status})`));
    return j;
  });

const usd = (n, d = 0) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);

const DECISION = {
  FIGHT: { label: 'Fight it', cls: 'fight', verb: 'Submit evidence to PayPal', done: 'Evidence submitted to PayPal' },
  OFFER: { label: 'Partial refund', cls: 'offer', verb: 'Send offer', done: 'Offer sent to buyer' },
  ACCEPT: { label: 'Refund buyer', cls: 'accept', verb: 'Refund buyer', done: 'Buyer refunded' },
};

const STATUS = {
  WAITING_FOR_SELLER_RESPONSE: 'Needs reply',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting on buyer',
  UNDER_REVIEW: 'PayPal reviewing',
  OPEN: 'Open',
  RESOLVED: 'Closed',
};

function daysLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - Date.now()) / 86_400_000);
}

const gridTheme = themeQuartz.withParams({
  fontFamily: "'Geist Variable', system-ui, sans-serif",
  fontSize: 14,
  headerFontSize: 12.5,
  headerFontWeight: 500,
  headerTextColor: '#6B7488',
  headerBackgroundColor: '#FFFFFF',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#0E1730',
  borderColor: '#E8EBF0',
  columnBorder: false,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: '#E8EBF0',
  rowBorder: { color: '#EEF0F4' },
  wrapperBorder: false,
  rowHoverColor: '#F6F8FB',
  selectedRowBackgroundColor: '#EEF2FA',
  accentColor: '#2F5BEA',
  rowHeight: 54,
  headerHeight: 46,
  cellHorizontalPadding: 14,
});

export default function App() {
  const [config, setConfig] = useState(null);
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [triaging, setTriaging] = useState(false);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);

  const [source, setSourceState] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api('/disputes'), api('/stats')]);
      setRows(r);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(e instanceof TypeError ? "The DisputeShield server isn't running. Start it with npm start." : e.message);
    }
  }, []);

  // Pick the starting source: a ?source= link (PayPal's return), then the last one used, then the server default.
  useEffect(() => {
    api('/config').then((c) => {
      let start = new URLSearchParams(window.location.search).get('source');
      if (!start) { try { start = localStorage.getItem('ds-source'); } catch { /* storage unavailable */ } }
      if (!c.sources.includes(start)) start = c.defaultSource;
      SOURCE = start;
      setSourceState(start);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!source) return;
    SOURCE = source;
    try { localStorage.setItem('ds-source', source); } catch { /* storage unavailable */ }
    setRows([]);
    setStats(null);
    setSelected(null);
    api('/config').then(setConfig).catch((e) => setError(e.message));
    refresh();
  }, [source, refresh]);

  const switchSource = (next) => { if (next !== source) setSourceState(next); };
  const readOnly = !!config?.readOnly;
  const hasLive = config?.sources?.includes('sandbox');

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  };

  const triage = async () => {
    setTriaging(true);
    try {
      const r = await api('/triage', { method: 'POST' });
      await refresh();
      notify(r.analyzed.length ? `Analyzed ${r.analyzed.length} open case${r.analyzed.length > 1 ? 's' : ''}` : 'Every open case is already analyzed');
    } catch (e) {
      notify(e.message);
    }
    setTriaging(false);
  };

  const resetDemo = async () => {
    await api('/demo/reset', { method: 'POST' });
    setSelected(null);
    refresh();
  };

  return (
    <div className="app">
      <div className="hero">
        <div className="hero-inner">
          <header className="top">
            <div className="brand">
              <Shield />
              <div>
                <h1>DisputeShield</h1>
                <p className="sub">{config ? `${config.merchant.name} · ${config.merchant.location}` : 'Loading…'}</p>
              </div>
            </div>
            <div className="top-actions">
              {config && hasLive && (
                <div className="source-switch" role="radiogroup" aria-label="Data shown">
                  <button role="radio" aria-checked={source === 'demo'} className={source === 'demo' ? 'on' : ''} onClick={() => switchSource('demo')}>
                    Demo data
                  </button>
                  <button role="radio" aria-checked={source === 'sandbox'} className={source === 'sandbox' ? 'on' : ''} onClick={() => switchSource('sandbox')}>
                    <span className="mode-dot live" aria-hidden />Live PayPal {config.env}
                  </button>
                </div>
              )}
              {config && !hasLive && (
                <span className={`mode ${config.mode}`} title="Using built-in demo data">
                  <span className="mode-dot" aria-hidden />
                  Demo data{config.ai ? ' with AI drafting' : ''}
                </span>
              )}
              {source === 'demo' && (
                <button className="ghost on-dark" onClick={resetDemo}>Reset demo</button>
              )}
              <button className="primary on-dark" onClick={triage} disabled={triaging}>
                {triaging ? <><span className="spinner" aria-hidden /> Analyzing cases</> : <><Spark /> Analyze all open cases</>}
              </button>
            </div>
          </header>
          {readOnly && (
            <p className="viewonly-note">
              These are real disputes in our PayPal sandbox. You can run the agent on them, but submitting is turned off here so every visitor sees the same cases. Switch to Demo data to try the full flow.
            </p>
          )}
          <Stats stats={stats} />
          {error && (
            <div className="banner" role="alert">
              <strong>Something went wrong loading your disputes.</strong>
              <span>{error}</span>
              <button className="ghost on-dark" onClick={refresh}>Try again</button>
            </div>
          )}
        </div>
      </div>


      <main className="split">
        <section className="grid-wrap" aria-label="Disputes">
          <CaseGrid rows={rows} selectedId={selected} onSelect={setSelected} />
        </section>
        <section className="panel" aria-label="Case file">
          {selected ? (
            <CaseFile key={`${source}-${selected}`} id={selected} onChange={refresh} notify={notify} readOnly={readOnly} />
          ) : (
            <Empty rows={rows} onPick={setSelected} sandbox={source === 'sandbox' && config?.env === 'sandbox' && !readOnly} onRefresh={refresh} notify={notify} />
          )}
        </section>
      </main>
      {toast && <div className="toast" role="status" key={toast}><span className="toast-icon" aria-hidden>✓</span>{toast}</div>}
    </div>
  );
}

function Stats({ stats }) {
  const s = stats || {};
  return (
    <section className="stats" aria-label="Summary">
      <Stat value={s.atRisk} fmt={(v) => usd(v)} label={`at risk across ${s.openCount ?? '—'} open cases`} />
      <Stat value={s.dueSoon} fmt={(v) => Math.round(v)} label="responses due in the next 3 days" tone={s.dueSoon > 0 ? 'warn' : ''} />
      <Stat value={s.projectedSaved} fmt={(v) => usd(v)} label={s.analyzed ? `expected to keep, from ${s.analyzed} analyzed cases` : 'expected to keep once cases are analyzed'} tone="good" />
      <Stat value={s.winRate == null ? null : s.winRate * 100} fmt={(v) => `${Math.round(v)}%`} label={`win rate, ${usd(s.recovered)} recovered`} />
    </section>
  );
}

function Stat({ value, fmt, label, tone = '' }) {
  const shown = useCountUp(value);
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-value">{value == null ? '—' : fmt(shown)}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function useCountUp(target, ms = 700) {
  const [v, setV] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const start = performance.now();
    const a = from.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || a === target) { setV(target); from.current = target; return; }
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function CaseGrid({ rows, selectedId, onSelect }) {
  const gridRef = useRef();
  const cols = useMemo(() => [
    { field: 'id', headerName: 'Case', width: 172, cellClass: 'mono-ish' },
    { field: 'reasonLabel', headerName: 'Claim', flex: 1, minWidth: 150, tooltipValueGetter: (p) => `${p.data.buyer} · ${p.data.item}` },
    { field: 'amount', headerName: 'Amount', width: 98, type: 'rightAligned', valueFormatter: (p) => usd(p.value), sort: 'desc' },
    {
      field: 'dueDate', headerName: 'Respond by', width: 118,
      comparator: (a, b) => (a ? new Date(a) : Infinity) - (b ? new Date(b) : Infinity),
      cellRenderer: (p) => {
        if (p.data.status === 'RESOLVED' || !p.value) return <span className="muted">—</span>;
        const d = daysLeft(p.value);
        return <span className={d <= 2 ? 'due urgent' : 'due'}>{d <= 0 ? 'Today' : d === 1 ? '1 day left' : `${d} days left`}</span>;
      },
    },
    {
      field: 'decision', headerName: 'Recommendation', width: 178,
      comparator: (a, b, na, nb) => (na.data.winProbability ?? -1) - (nb.data.winProbability ?? -1),
      cellRenderer: (p) => (p.value ? (
        <span className="rec">
          <span className={`pill ${DECISION[p.value].cls}`}>{DECISION[p.value].label}</span>
          <span className="rec-win" title="Win chance">{Math.round(p.data.winProbability * 100)}%</span>
        </span>
      ) : p.data.status === 'RESOLVED' ? <span className="muted">—</span> : <span className="muted">Not analyzed</span>),
    },
    {
      field: 'status', headerName: 'Status', width: 132,
      valueFormatter: (p) => (p.value === 'RESOLVED' ? outcomeLabel(p.data.outcome) : STATUS[p.value] || p.value),
      cellClassRules: { won: (p) => /SELLER/.test(p.data.outcome || ''), lost: (p) => /BUYER/.test(p.data.outcome || ''), settled: (p) => /PAYOUT/.test(p.data.outcome || '') },
    },
  ], []);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.forEachNode((n) => n.setSelected(n.data.id === selectedId));
  }, [selectedId, rows]);

  return (
    <div className="grid">
      <AgGridReact
        ref={gridRef}
        theme={gridTheme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.id}
        rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
        onRowClicked={(e) => onSelect(e.data.id)}
        getRowClass={(p) => (p.data.status === 'RESOLVED' ? 'row-closed' : '')}
        defaultColDef={{ sortable: true, resizable: true }}
        tooltipShowDelay={300}
        overlayNoRowsTemplate={'<span style="color:#5d667a">No disputes yet. Create a test payment on the right, then dispute it as the buyer.</span>'}
        suppressCellFocus
        animateRows
      />
    </div>
  );
}

const outcomeLabel = (o) => (!o ? 'Closed' : /SELLER/.test(o) ? 'Won' : /PAYOUT/.test(o) ? 'Settled' : 'Refunded');

function Empty({ rows, onPick, sandbox, onRefresh, notify }) {
  const next = rows.filter((r) => r.status !== 'RESOLVED').sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
  return (
    <div className="empty">
      <h2>Pick a case to build its defence</h2>
      <p>The agent reads the PayPal dispute, finds the order, tracking, refunds and customer messages, then tells you whether to fight, offer or refund, and why.</p>
      {next && (
        <button className="primary" onClick={() => onPick(next.id)}>
          Start with the most urgent: {next.id} ({usd(next.amount)})
        </button>
      )}
      {sandbox && <TestData onRefresh={onRefresh} notify={notify} />}
    </div>
  );
}

function TestData({ onRefresh, notify }) {
  const [info, setInfo] = useState(null);
  const [scenario, setScenario] = useState('delivered');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [checking, setChecking] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const justPaid = params.get('sandbox') === 'paid' ? params.get('txn') : null;
  const returnErr = params.get('sandbox') === 'error' ? params.get('msg') : null;

  useEffect(() => { api('/sandbox/scenarios').then(setInfo).catch((e) => setErr(e.message)); }, []);

  const pay = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('/sandbox/test-payment', { method: 'POST', body: JSON.stringify({ scenario }) });
      window.location.href = r.approveUrl;
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    await onRefresh();
    setChecking(false);
    notify('Checked PayPal for new disputes');
  };

  const copy = (t) => { navigator.clipboard?.writeText(t); notify('Transaction ID copied'); };

  return (
    <section className="testdata" aria-label="Sandbox test data">
      <h3>Add a test dispute</h3>
      {justPaid && <p className="ok-note">Payment captured. Transaction <code>{justPaid}</code> is ready to dispute.</p>}
      {(returnErr || err) && <p className="error">{returnErr || err}</p>}
      <ol className="howto">
        <li>
          <strong>Pick a story and pay as the sandbox buyer</strong>
          <span>You'll log in with your sandbox personal account (Developer Dashboard › Testing tools › Sandbox accounts), not your real PayPal.</span>
          <div className="scenarios" role="radiogroup">
            {(info?.scenarios || []).map((s) => (
              <label key={s.id} className={scenario === s.id ? 'on' : ''}>
                <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => setScenario(s.id)} />
                <span><b>{s.item}</b> · ${s.price}<em>{s.label}</em></span>
              </label>
            ))}
          </div>
          <button className="primary" onClick={pay} disabled={busy || !info}>{busy ? 'Opening PayPal…' : 'Pay with sandbox PayPal'}</button>
        </li>
        <li>
          <strong>Open a dispute as that buyer</strong>
          <span>Log in to <a href="https://www.sandbox.paypal.com/myaccount/summary" target="_blank" rel="noreferrer">sandbox.paypal.com</a> with the same buyer, open the payment in Activity and choose Report a problem. Pick "item not received" for the first two stories, "not as described" for the stole.</span>
        </li>
        <li>
          <strong>Bring it in</strong>
          <span>New disputes can take a few minutes to show up in PayPal's API.</span>
          <button className="ghost" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check for new disputes'}</button>
        </li>
      </ol>
      {info?.payments?.length > 0 && (
        <details className="payments">
          <summary>Test payments ({info.payments.length})</summary>
          <ul>
            {info.payments.map((p) => (
              <li key={p.transactionId}>
                <button className="link" onClick={() => copy(p.transactionId)} title="Copy transaction ID"><code>{p.transactionId}</code></button>
                <span>{p.item} · ${p.amount}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CaseFile({ id, onChange, notify, readOnly }) {
  const [data, setData] = useState(null);
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const d = await api(`/disputes/${id}`);
    setData(d);
    if (d.analysis) setNotes(d.analysis.draft.response_notes);
    return d;
  }, [id]);

  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, [load]);

  const analyze = () => {
    setSteps([]);
    setErr(null);
    setRunning(true);
    const es = new EventSource(withSource(`/api/disputes/${id}/analyze`));
    es.addEventListener('step', (e) => setSteps((s) => [...s, JSON.parse(e.data)]));
    es.addEventListener('result', async () => {
      es.close();
      await load();
      setRunning(false);
      onChange();
    });
    es.addEventListener('error', (e) => {
      es.close();
      setRunning(false);
      try { setErr(JSON.parse(e.data).error); } catch { setErr('The agent stopped unexpectedly. Try again.'); }
    });
  };

  const act = async (action) => {
    setBusy(true);
    setErr(null);
    try {
      if (notes !== data.analysis.draft.response_notes) {
        await api(`/disputes/${id}/draft`, { method: 'PATCH', body: JSON.stringify({ response_notes: notes }) });
      }
      await api(`/disputes/${id}/submit`, { method: 'POST', body: JSON.stringify({ action }) });
      notify(DECISION[action].done);
      await load();
      onChange();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const simulate = async () => {
    setBusy(true);
    try {
      const r = await api(`/disputes/${id}/simulate-decision`, { method: 'POST', body: '{}' });
      notify(`PayPal decided: ${outcomeLabel(r.row.outcome)}`);
      await load();
      onChange();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const upload = async (files) => {
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    await fetch(withSource(`/api/disputes/${id}/documents`), { method: 'POST', body: fd });
    await load();
    notify(`Added ${files.length} file${files.length > 1 ? 's' : ''} to the evidence`);
  };

  if (!data) return err ? <div className="empty"><p>{err}</p></div> : <Skeleton />;
  const { row, dispute, context, analysis: a } = data;
  const resolved = row.status === 'RESOLVED';
  const d = daysLeft(row.dueDate);

  return (
    <article className="case">
      <header className="case-head">
        <div>
          <h2>{row.reasonLabel} <span className="amt">{usd(row.amount, 2)}</span></h2>
          <p className="sub">
            {row.id} · {row.buyer} · {row.item}
          </p>
        </div>
        <div className="case-status">
          {resolved ? <span className={`outcome ${/SELLER/.test(row.outcome) ? 'won' : /PAYOUT/.test(row.outcome) ? 'settled' : 'lost'}`}>{outcomeLabel(row.outcome)}</span>
            : <span className={d <= 2 ? 'due urgent' : 'due'}>{STATUS[row.status]}{d != null ? ` · ${d <= 0 ? 'due today' : `${d}d left`}` : ''}</span>}
        </div>
      </header>

      {(dispute.messages || []).length > 0 && (
        <blockquote className="buyer-says">
          <span className="who">{row.buyer.split(' ')[0]} told PayPal</span>
          {dispute.messages[0].content}
        </blockquote>
      )}

      {!a && !running && (
        <div className="cta-block">
          <p>The agent will pull this order's tracking, refunds and messages{context ? '' : ' (no store order is linked to this PayPal transaction yet, so it will work from the dispute alone)'}, check them against what PayPal needs for this claim, and draft your response.</p>
          <button className="primary big" onClick={analyze}>Build the case</button>
        </div>
      )}

      {(running || (steps.length > 0 && !a)) && <Steps steps={steps} running={running} />}

      {a && (
        <>
          <Verdict a={a} />
          {a.honestyFlag && <p className="honest">{a.honestyFlag}</p>}

          <div className="two">
            <section>
              <h3>Evidence PayPal looks for</h3>
              <ul className="checklist">
                {a.checklist.map((c) => (
                  <li key={c.item} className={c.have ? 'have' : 'miss'}>
                    <span className="tick" aria-hidden>{c.have ? '✓' : '–'}</span>
                    <span><strong>{c.item}</strong>{c.detail && <em>{c.detail}</em>}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Why</h3>
              <p className="reasoning">{a.draft.reasoning}</p>
              {a.draft.risks?.length > 0 && (
                <ul className="risks">{a.draft.risks.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
            </section>
          </div>

          {a.decision === 'FIGHT' && (
            <section>
              <h3>Your response to PayPal <span className="hint">edit before sending</span></h3>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={7} disabled={!!a.submitted} />
              <div className="files">
                <a href={withSource(`/api/disputes/${id}/evidence.pdf`)} target="_blank" rel="noreferrer">Preview evidence pack (PDF)</a>
                {data.documents.map((f) => <span key={f.name} className="file">{f.name}</span>)}
                {!a.submitted && !readOnly && (
                  <label className="link">
                    Add photos or documents
                    <input type="file" multiple hidden onChange={(e) => e.target.files.length && upload(e.target.files)} />
                  </label>
                )}
              </div>
            </section>
          )}
          {a.decision !== 'FIGHT' && a.draft.buyer_message && (
            <section>
              <h3>Message to the buyer</h3>
              <p className="buyer-msg">{a.draft.buyer_message}</p>
            </section>
          )}

          {err && <p className="error">{err}</p>}

          <footer className="actions">
            {readOnly ? (
              <div className="submitted">
                <p className="viewonly-inline">View-only: this is a live PayPal sandbox dispute, so submitting is turned off on the public demo.</p>
                <button className="ghost" onClick={analyze} disabled={running}>Re-run analysis</button>
              </div>
            ) : !a.submitted && !resolved ? (
              <>
                <button className={`primary big ${DECISION[a.decision].cls}`} onClick={() => act(a.decision)} disabled={busy}>
                  {busy ? 'Sending to PayPal…' : a.decision === 'OFFER' ? `Send ${usd(a.offer?.amount, 2)} offer` : a.decision === 'ACCEPT' ? `Refund ${usd(row.amount, 2)}` : DECISION[a.decision].verb}
                </button>
                <div className="alt">
                  {['FIGHT', 'OFFER', 'ACCEPT'].filter((x) => x !== a.decision && (x !== 'OFFER' || a.offer)).map((x) => (
                    <button key={x} className="ghost" onClick={() => act(x)} disabled={busy}>{DECISION[x].label} instead</button>
                  ))}
                  <button className="ghost" onClick={analyze} disabled={busy || running}>Re-run analysis</button>
                </div>
              </>
            ) : (
              <div className="submitted">
                <p>{a.submitted ? `${DECISION[a.submitted.action].done} on ${new Date(a.submitted.at).toLocaleString()}.` : 'This case is closed.'}</p>
                {!resolved && (
                  <button className="ghost" onClick={simulate} disabled={busy}>Simulate PayPal's decision (sandbox)</button>
                )}
              </div>
            )}
          </footer>
          {running && <Steps steps={steps} running />}
          <Activity items={data.activity} />
        </>
      )}
    </article>
  );
}

function Steps({ steps, running }) {
  return (
    <ol className="steps" aria-live="polite">
      {steps.map((s, i) => (
        <li key={i} className="done" style={{ animationDelay: '0ms' }}>
          <span className="dot" aria-hidden>✓</span>
          <div><strong>{s.label}</strong>{s.detail && <span>{s.detail}</span>}</div>
        </li>
      ))}
      {running && (
        <li className="pending"><span className="dot" aria-hidden /><div><strong>Working…</strong></div></li>
      )}
    </ol>
  );
}

function Verdict({ a }) {
  const D = DECISION[a.decision];
  const e = a.economics;
  const max = Math.max(e.refundLoss, e.expectedLossFight, e.offerCost || 0, 1);
  const bars = [
    { k: 'Fight', v: e.expectedLossFight, cls: 'fight', note: `expected loss at ${Math.round(a.winProbability * 100)}% win chance, incl. $${e.fee} dispute fee` },
    e.offerCost != null && { k: 'Offer', v: e.offerCost, cls: 'offer', note: `${Math.round(a.offer.pct * 100)}% partial refund, buyer keeps item` },
    { k: 'Refund', v: e.refundLoss, cls: 'accept', note: 'full refund' },
  ].filter(Boolean);
  const [grown, setGrown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrown(true), 60); return () => clearTimeout(t); }, []);
  return (
    <section className={`verdict ${D.cls}`}>
      <div className="verdict-top">
        <div className="verdict-main">
          <span className="verdict-icon" aria-hidden><DecisionIcon kind={a.decision} /></span>
          <div>
          <div className="verdict-label">{D.label}</div>
          <p className="verdict-summary">{a.draft.summary}</p>
          </div>
        </div>
        <div className="verdict-win">
          <span>{Math.round(a.winProbability * 100)}%</span>
          win chance
        </div>
      </div>
      <div className="money" aria-label="What each option costs you">
        {bars.map((b) => (
          <div key={b.k} className={`money-row ${b.cls} ${b.cls === D.cls ? 'chosen' : ''}`}>
            <span className="money-k">{b.k}</span>
            <span className="money-track"><span style={{ width: grown ? `${(b.v / max) * 100}%` : 0 }} /></span>
            <span className="money-v">{usd(b.v, 2)}</span>
            <span className="money-note">{b.note}</span>
          </div>
        ))}
      </div>
      {e.expectedSaved > 0 && <p className="saved">Following this keeps about {usd(e.expectedSaved, 2)} in your account compared with refunding.</p>}
    </section>
  );
}

function Activity({ items }) {
  if (!items?.length) return null;
  return (
    <details className="activity">
      <summary>Audit trail ({items.length})</summary>
      <ul>
        {items.map((x, i) => (
          <li key={i}><time>{new Date(x.at).toLocaleTimeString()}</time> {x.action.replaceAll('_', ' ').toLowerCase()}: {x.detail}</li>
        ))}
      </ul>
    </details>
  );
}

function Shield() {
  return (
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2 4 6.5v8.2C4 22.4 9.1 28.3 16 30c6.9-1.7 12-7.6 12-15.3V6.5L16 2Z" fill="#2F5BEA" />
      <path d="m10.5 16.2 3.7 3.7 7.3-7.6" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Skeleton() {
  return (
    <div className="case" aria-busy="true">
      <div className="sk sk-title" />
      <div className="sk sk-line" />
      <div className="sk sk-block" />
      <div className="sk sk-line short" />
    </div>
  );
}

function Spark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4L8 1.5Z" fill="currentColor" />
    </svg>
  );
}

function DecisionIcon({ kind }) {
  if (kind === 'FIGHT') {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2.5 4.5 5.4v5.4c0 4.9 3.2 8.6 7.5 9.7 4.3-1.1 7.5-4.8 7.5-9.7V5.4L12 2.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="m8.6 11.8 2.4 2.4 4.5-4.7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  }
  if (kind === 'OFFER') {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 3.5V12h8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 7 4.5 11.5 9 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
  );
}
