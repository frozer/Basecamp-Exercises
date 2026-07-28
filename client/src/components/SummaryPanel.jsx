import React, { useCallback, useEffect, useState } from 'react';
import '../styles/panels.css';
import {
  PRIORITIES,
  getJob,
  listEmails,
  listPendingJobs,
  queueSummarization,
  submitJobSummary,
  summarizeEmails,
} from '../api';
import { formatSentAt, formatTimestamp } from '../dates';

function SummaryPanel() {
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('');
  const [digest, setDigest] = useState(null);
  const [matched, setMatched] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [pending, setPending] = useState([]);
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState({});
  const [lookupId, setLookupId] = useState('');
  const [lookup, setLookup] = useState(null);

  const loadDigest = useCallback(async (filters) => {
    setLoading(true);
    setError('');
    try {
      // The digest returns ids only, so the e-mails themselves come alongside it.
      const [summary, emails] = await Promise.all([
        summarizeEmails(filters),
        listEmails(filters),
      ]);
      setDigest(summary);
      setMatched(emails);
    } catch (err) {
      setError(err.message);
      setDigest(null);
      setMatched([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      setPending(await listPendingJobs());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadDigest({});
    loadPending();
  }, [loadDigest, loadPending]);

  const handleApply = (event) => {
    event.preventDefault();
    loadDigest({ q: search.trim(), priority });
  };

  const handleQueue = async () => {
    if (!digest?.emailIds?.length) return;
    setNotice('');
    setError('');
    try {
      const { id } = await queueSummarization(digest.emailIds);
      setNotice(`Queued summarization #${id} for ${digest.emailIds.length} e-mail(s).`);
      await loadPending();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSubmitSummary = async (event, jobId) => {
    event.preventDefault();
    const text = (drafts[jobId] ?? '').trim();
    if (!text) {
      setError('A summary must not be blank.');
      return;
    }
    setNotice('');
    setError('');
    try {
      const job = await submitJobSummary(jobId, text);
      setNotice(`Summary stored on #${job.id}; it has left the pending queue.`);
      setDrafts(({ [jobId]: _removed, ...rest }) => rest);
      setLookup(job);
      await loadPending();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleLookup = async (event) => {
    event.preventDefault();
    setError('');
    try {
      setLookup(await getJob(lookupId));
    } catch (err) {
      setLookup(null);
      setError(err.message);
    }
  };

  return (
    <div className="panel-container">
      <div className="panel-header">
        <h2>📊 Summarize</h2>
        <p className="subtitle">
          A digest from <code>GET /emails/summarize</code>, plus the{' '}
          <code>/summarize</code> job queue
        </p>
      </div>

      <div className="filter-section">
        <form className="search-form" onSubmit={handleApply}>
          <input
            type="search"
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search subject and body…"
            aria-label="Search e-mails"
          />
          <select
            className="select-input"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            aria-label="Filter by priority"
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </form>
      </div>

      {error && <div className="error-message">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {loading ? (
        <div className="loading">Loading digest…</div>
      ) : digest ? (
        <>
          <div className="stats-section">
            <div className="stat-card">
              <span className="stat-number">{digest.count}</span>
              <span className="stat-label">Matched e-mails</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{pending.length}</span>
              <span className="stat-label">Pending jobs</span>
            </div>
          </div>

          <section className="email-section">
            <h3 className="section-title">📝 Digest</h3>
            {digest.summary ? (
              <p className="summary-text">{digest.summary}</p>
            ) : (
              <p className="notice notice-info">
                The API answered <code>status: {digest.status}</code> — the summariser in{' '}
                <code>api/app/summarizer.py</code> is still a stub, so no text is generated
                yet. Queueing a job below and submitting the text by hand is the path that
                works today.
              </p>
            )}
            <div className="panel-actions">
              <button
                className="btn-primary"
                onClick={handleQueue}
                disabled={!digest.count}
              >
                Queue these {digest.count} e-mail(s) for summarization
              </button>
            </div>
          </section>

          <section className="email-section">
            <h3 className="section-title">📧 Matched E-mails</h3>
            {matched.length > 0 ? (
              <div className="email-list">
                {matched.map((email) => (
                  <div key={email.id} className="email-card">
                    <div className="email-header">
                      <h4 className="email-subject">{email.subject}</h4>
                      <span className="email-time">{formatSentAt(email)}</span>
                    </div>
                    <p className="email-from">
                      {email.from} → {email.to}
                    </p>
                    <div className="card-badges">
                      <span className="badge">#{email.id}</span>
                      <span className="badge">{email.priority}</span>
                    </div>
                    <p className="email-preview">{email.body}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">No e-mails match these filters</p>
            )}
          </section>
        </>
      ) : null}

      <section className="email-section">
        <h3 className="section-title">⏳ Pending Jobs</h3>
        {pending.length > 0 ? (
          <div className="email-list">
            {pending.map((job) => (
              <div key={job.id} className="email-card job-card">
                <div className="email-header">
                  <h4 className="email-subject">Summarization #{job.id}</h4>
                  <span className="email-time">{formatTimestamp(job.createdAt)}</span>
                </div>
                <p className="job-meta">E-mail ids: {job.emailIds.join(', ') || '—'}</p>
                <form className="job-form" onSubmit={(event) => handleSubmitSummary(event, job.id)}>
                  <textarea
                    className="job-textarea"
                    rows={3}
                    value={drafts[job.id] ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [job.id]: event.target.value }))
                    }
                    placeholder="Write the summary for these e-mails…"
                    aria-label={`Summary for job ${job.id}`}
                  />
                  <button type="submit" className="btn-primary">
                    Submit summary
                  </button>
                </form>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">Nothing waiting for a summary</p>
        )}
      </section>

      <section className="email-section">
        <h3 className="section-title">🔍 Look Up a Summarization</h3>
        {/* Submitted jobs leave the pending list and the API has no list-all
            route, so an id is the only way back to a finished summary. */}
        <form className="inline-form" onSubmit={handleLookup}>
          <input
            type="number"
            min="1"
            className="search-input"
            value={lookupId}
            onChange={(event) => setLookupId(event.target.value)}
            placeholder="Summarization id"
            aria-label="Summarization id"
          />
          <button type="submit" className="btn-primary" disabled={!lookupId}>
            Fetch
          </button>
        </form>
        {lookup && (
          <div className="email-card job-card">
            <h4 className="email-subject">Summarization #{lookup.id}</h4>
            {lookup.summary ? (
              <p className="summary-text">{lookup.summary}</p>
            ) : (
              <p className="job-meta">Still pending — no summary submitted yet.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default SummaryPanel;
