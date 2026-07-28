import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../styles/panels.css';
import { listEmails } from '../api';
import { formatSentAt, todayIso, withinRange } from '../dates';

// The API's Priority enum, most urgent first. The top band is `critical`, not
// `high`; the CSS class names keep the original palette hooks.
const BANDS = [
  {
    value: 'critical',
    heading: 'Critical - Requires Immediate Attention',
    empty: 'No critical e-mails',
    icon: '🔴',
    color: '#ef4444',
    modifier: 'high',
  },
  {
    value: 'medium',
    heading: 'Medium - Review Soon',
    empty: 'No medium priority e-mails',
    icon: '🟡',
    color: '#f59e0b',
    modifier: 'medium',
  },
  {
    value: 'low',
    heading: 'Low - Can Be Reviewed Later',
    empty: 'No low priority e-mails',
    icon: '🟢',
    color: '#10b981',
    modifier: 'low',
  },
];

const PREVIEW_LIMIT = 200;

function preview(body) {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function PriorityPanel() {
  const [emails, setEmails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dateMode, setDateMode] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // The applied range, separate from the pickers above so typing a date does
  // not filter until Load is pressed.
  const [range, setRange] = useState({ from: '', to: '' });

  const load = useCallback(async (q) => {
    setLoading(true);
    setError('');
    try {
      setEmails(await listEmails({ q }));
    } catch (err) {
      setError(err.message);
      setEmails(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load('');
  }, [load]);

  const handleSearch = (event) => {
    event.preventDefault();
    load(search.trim());
  };

  // GET /emails takes `q` and `priority` only, so the day filter runs here over
  // the contract's `date` field.
  const visible = useMemo(() => withinRange(emails ?? [], range), [emails, range]);

  const grouped = useMemo(() => {
    const groups = Object.fromEntries(BANDS.map((band) => [band.value, []]));
    for (const email of visible) groups[email.priority]?.push(email);
    return groups;
  }, [visible]);

  const handleShowAll = () => {
    setDateMode('all');
    setRange({ from: '', to: '' });
  };

  const handleShowToday = () => {
    const today = todayIso();
    setDateMode('today');
    setRange({ from: today, to: today });
  };

  const handleShowRange = () => {
    if (!startDate || !endDate) {
      setError('Please select both start and end dates');
      return;
    }
    setError('');
    setRange({ from: startDate, to: endDate });
  };

  return (
    <div className="panel-container">
      <div className="panel-header">
        <h2>⚡ Inbox by Priority</h2>
        <p className="subtitle">
          Every e-mail from <code>GET /emails</code>, grouped by its priority
        </p>
      </div>

      <div className="filter-section">
        <form className="search-form" onSubmit={handleSearch}>
          <input
            type="search"
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search subject and body…"
            aria-label="Search e-mails"
          />
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        <div className="filter-buttons">
          <button
            className={`filter-btn ${dateMode === 'all' ? 'active' : ''}`}
            onClick={handleShowAll}
          >
            All Time
          </button>
          <button
            className={`filter-btn ${dateMode === 'today' ? 'active' : ''}`}
            onClick={handleShowToday}
          >
            Today
          </button>
          <button
            className={`filter-btn ${dateMode === 'range' ? 'active' : ''}`}
            onClick={() => setDateMode('range')}
          >
            Date Range
          </button>
        </div>

        {dateMode === 'range' && (
          <div className="date-range-selector">
            <div className="date-input-group">
              <label htmlFor="priority-from">From</label>
              <input
                id="priority-from"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="date-input-group">
              <label htmlFor="priority-to">To</label>
              <input
                id="priority-to"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </div>
            <button
              onClick={handleShowRange}
              className="btn-primary"
              disabled={!startDate || !endDate}
            >
              Load
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading e-mails…</div>
      ) : emails ? (
        <>
          <div className="stats-section">
            {BANDS.map((band) => (
              <div key={band.value} className={`stat-card ${band.modifier}-priority`}>
                <span className="stat-number">{grouped[band.value].length}</span>
                <span className="stat-label">{band.value}</span>
              </div>
            ))}
            <div className="stat-card">
              <span className="stat-number">{visible.length}</span>
              <span className="stat-label">Shown</span>
            </div>
          </div>

          {BANDS.map((band) => (
            <section key={band.value} className={`priority-section ${band.modifier}`}>
              <h3 className="section-title">
                {band.icon} {band.heading}
              </h3>
              {grouped[band.value].length > 0 ? (
                <div className="priority-list">
                  {grouped[band.value].map((email) => (
                    <div
                      key={email.id}
                      className="priority-card"
                      style={{ borderLeftColor: band.color }}
                    >
                      <div className="priority-header">
                        <div className="priority-title">
                          <span className="priority-icon">{band.icon}</span>
                          <h4>{email.subject}</h4>
                        </div>
                        <span className="email-time">{formatSentAt(email)}</span>
                      </div>
                      <p className="email-from">
                        {email.from} → {email.to}
                      </p>
                      <div className="card-badges">
                        <span className="badge">#{email.id}</span>
                        <span className="badge">{email.priority}</span>
                        {email.highPriority && <span className="badge badge-flag">highPriority</span>}
                      </div>
                      <p className="email-preview">{preview(email.body)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-state">{band.empty}</p>
              )}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}

export default PriorityPanel;
