import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/panels.css';
import { getAgenda } from '../api';
import { formatSentAt, formatTimestamp } from '../dates';

// The worker in ../agent/emailProcessing.py re-posts the plan every ~10s, so
// polling at half that keeps the screen at most one cycle behind.
const POLL_MS = 5000;
const PREVIEW_LIMIT = 200;

/** The worker joins several notes into one field with ` | `; one line each. */
function noteLines(text) {
  return (text ?? '')
    .split(' | ')
    .map((line) => line.trim())
    .filter(Boolean);
}

function preview(body) {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function NoteSection({ icon, title, text, empty }) {
  const lines = noteLines(text);
  return (
    <section className="email-section">
      <h3 className="section-title">
        {icon} {title}
      </h3>
      {lines.length > 0 ? (
        <ul className="note-list">
          {lines.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">{empty}</p>
      )}
    </section>
  );
}

function AgendaPanel() {
  const [agenda, setAgenda] = useState(null);
  // A 404 means the worker has not written today's plan yet — an empty state,
  // not a failure, so it is tracked apart from `error`.
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);

  // Responses can land after unmount, and a slow API must not stack up ticks.
  const alive = useRef(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const plan = await getAgenda();
      if (!alive.current) return;
      setAgenda(plan);
      setMissing(false);
      setError('');
      setUpdatedAt(new Date());
    } catch (err) {
      if (!alive.current) return;
      if (err.status === 404) {
        setAgenda(null);
        setMissing(true);
        setError('');
        setUpdatedAt(new Date());
      } else {
        // Keep the last good plan on screen; a blip should not blank the panel.
        setError(err.message);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Reset for StrictMode's mount/unmount/mount in development.
    alive.current = true;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="panel-container">
      <div className="panel-header">
        <h2>🗓 Agenda</h2>
        <p className="subtitle">
          Today's plan from <code>GET /agenda</code>, written by the worker in{' '}
          <code>agent/emailProcessing.py</code>
        </p>
        <p className="job-meta">
          Refreshing every {POLL_MS / 1000}s
          {updatedAt && ` · checked ${formatTimestamp(updatedAt)}`}
        </p>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading today's plan…</div>
      ) : missing ? (
        <p className="notice notice-info">
          No plan stored for today yet. Run the worker with{' '}
          <code>python agent/emailProcessing.py</code> — it posts one on its next
          cycle and this panel will pick it up within {POLL_MS / 1000}s.
        </p>
      ) : agenda ? (
        <>
          <div className="stats-section">
            <div className="stat-card high-priority">
              <span className="stat-number">{agenda.top.length}</span>
              <span className="stat-label">Top e-mails</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{noteLines(agenda.meeting).length}</span>
              <span className="stat-label">Meeting notes</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{noteLines(agenda.support).length}</span>
              <span className="stat-label">Support notes</span>
            </div>
          </div>

          <p className="job-meta">Plan stored {formatTimestamp(agenda.date)}</p>

          <NoteSection
            icon="🤝"
            title="Meeting"
            text={agenda.meeting}
            empty="No meeting notes on today's plan"
          />

          <NoteSection
            icon="🛟"
            title="Support"
            text={agenda.support}
            empty="No support notes on today's plan"
          />

          <section className="email-section">
            <h3 className="section-title">📌 Top E-mails</h3>
            {/* The API returns `top` in the worker's ranking order — never re-sort. */}
            {agenda.top.length > 0 ? (
              <div className="email-list">
                {agenda.top.map((email, index) => (
                  <div key={email.id} className="email-card">
                    <div className="email-header">
                      <h4 className="email-subject">{email.subject}</h4>
                      <span className="email-time">{formatSentAt(email)}</span>
                    </div>
                    <p className="email-from">
                      {email.from} → {email.to}
                    </p>
                    <div className="card-badges">
                      <span className="badge">Rank {index + 1}</span>
                      <span className="badge">#{email.id}</span>
                      <span className="badge">{email.priority}</span>
                      {email.highPriority && (
                        <span className="badge badge-flag">highPriority</span>
                      )}
                    </div>
                    <p className="email-preview">{preview(email.body)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">The plan names no e-mails</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

export default AgendaPanel;
