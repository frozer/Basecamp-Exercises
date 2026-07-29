import React, { useEffect, useState } from 'react';
import './App.css';
import AgendaPanel from './components/AgendaPanel';
import SummaryPanel from './components/SummaryPanel';
import PriorityPanel from './components/PriorityPanel';
import { health } from './api';

const TABS = [
  { id: 'agenda', label: 'Agenda', icon: '🗓' },
  { id: 'priority', label: 'Inbox', icon: '⚡' },
  { id: 'summary', label: 'Summarize', icon: '📊' },
];

function App() {
  // The agenda is the agent's headline output, so it is what opens.
  const [activeTab, setActiveTab] = useState('agenda');
  // The API has no accounts, so the only thing to report up here is liveness.
  const [apiStatus, setApiStatus] = useState('checking');

  useEffect(() => {
    let current = true;
    health()
      .then(() => current && setApiStatus('ok'))
      .catch(() => current && setApiStatus('down'));
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <h1>Email Manager</h1>
          <div className="header-info">
            <span className={`api-status ${apiStatus}`}>
              {apiStatus === 'ok' && 'API online'}
              {apiStatus === 'checking' && 'Checking API…'}
              {apiStatus === 'down' && 'API unreachable'}
            </span>
          </div>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <nav className="nav-menu">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="main-content">
          {apiStatus === 'down' && (
            <div className="error-message">
              Cannot reach the API. Start it from <code>api/</code> with{' '}
              <code>uvicorn app.main:app --reload --port 8000</code>.
            </div>
          )}

          {/* Unmounting stops the Agenda panel's poll — that is deliberate. */}
          {activeTab === 'agenda' && <AgendaPanel />}
          {activeTab === 'priority' && <PriorityPanel />}
          {activeTab === 'summary' && <SummaryPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
