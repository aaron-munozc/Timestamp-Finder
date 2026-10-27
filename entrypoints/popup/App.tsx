import { useEffect, useState } from 'react';
import type { Browser } from 'wxt/browser';


type PageState = 'checking' | 'video' | 'youtube' | 'other';

export default function App() {
  const [pageState, setPageState] = useState<PageState>('checking');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      let url: URL | null = null;
      try {
        if (tab && tab.url) url = new URL(tab.url);
      } catch {
        url = null;
      }
      if (url && /(^|\.)youtube\.com$/i.test(url.hostname)) {
        setPageState(url.pathname === '/watch' && Boolean(url.searchParams.get('v')) || /^\/shorts\//.test(url.pathname) ? 'video' : 'youtube');
      } else {
        setPageState('other');
      }
    }).catch(() => setPageState('other'));
  }, []);

  async function openPanel() {
    setFeedback('');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

      if (tab) {
        if (!tab.id) throw new Error('No active tab');
        await browser.tabs.sendMessage(tab.id, { type: 'YTTS_OPEN_PANEL' });
      }
      setFeedback('Timestamp panel opened on the video.');
    } catch {
      setFeedback('Open or refresh a YouTube video tab, then try again.');
    }
  }

  async function startScan() {
    setFeedback('');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        if (!tab.id) throw new Error('No active tab');
        await browser.tabs.sendMessage(tab.id, { type: 'YTTS_START_SCAN' });
      }
      setFeedback('Scan started. Results will appear in the page panel.');
    } catch {
      setFeedback('Open or refresh a YouTube video tab, then try again.');
    }
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-mark" aria-hidden="true">◷</div>
        <div className="popup-brand-copy">
          <div className="popup-eyebrow">YOUTUBE TOOL</div>
          <h1>Timestamp Finder</h1>
        </div>
        <span className={`connection-dot ${pageState === 'video' ? 'is-ready' : ''}`} title={pageState === 'video' ? 'Video page detected' : 'Waiting for a video'} />
      </header>

      <section className="popup-intro">
        <div className="popup-art" aria-hidden="true">
          <span className="art-ring art-ring-one" />
          <span className="art-ring art-ring-two" />
          <span className="art-time">12:48</span>
          <span className="art-play">▶</span>
        </div>
        <h2>Skip the scroll.<br /><span>Find the moment.</span></h2>
        <p>Collect timestamps hidden in YouTube comments and jump directly to the clips people mention.</p>
      </section>

      <section className="popup-status">
        <span className={`status-icon ${pageState === 'video' ? 'ready' : ''}`}>{pageState === 'video' ? '✓' : '·'}</span>
        <div>
          <strong>{pageState === 'video' ? 'YouTube video detected' : pageState === 'youtube' ? 'YouTube is open' : pageState === 'other' ? 'Waiting for YouTube' : 'Checking current tab'}</strong>
          <p>{pageState === 'video' ? 'The in-page panel is ready to use.' : pageState === 'youtube' ? 'Open a video to enable comment scanning.' : pageState === 'other' ? 'Open a YouTube video to get started.' : 'Looking for a supported page…'}</p>
        </div>
      </section>

      <div className="popup-actions">
        <button className="primary-action" type="button" onClick={() => void startScan()} disabled={pageState !== 'video'}>
          <span aria-hidden="true">⌕</span> Scan all comments
        </button>
        <button className="secondary-action" type="button" onClick={() => void openPanel()} disabled={pageState !== 'video'}>
          Show timestamp panel <span aria-hidden="true">↗</span>
        </button>
      </div>
      {feedback && <div className="popup-feedback" role="status">{feedback}</div>}

      <footer className="popup-footer">
        <span><i /> Private by design</span>
        <span>Runs locally in your browser</span>
      </footer>
    </main>
  );
}
