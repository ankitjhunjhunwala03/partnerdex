import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled rather than fetched: a self-hosted dashboard should not have its
// typography depend on reaching a font CDN.
import '@fontsource-variable/inter';
import App from './App';
import './styles.css';

/*
 * A tab left open across a deploy still holds the old build's page, whose
 * lazily loaded parts have new names on the server now. Opening one of them
 * fails, and the page goes blank. Reloading fetches the new build; the guard
 * stops a part that is genuinely missing from reloading forever.
 */
window.addEventListener('vite:preloadError', (event) => {
  const key = 'partnerdex:reloaded-for-deploy';
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// Once this build has been up long enough to have loaded, the next deploy may
// reload again.
window.setTimeout(() => {
  try {
    window.sessionStorage.removeItem('partnerdex:reloaded-for-deploy');
  } catch {
    // Storage unavailable: the guard above already declined to reload.
  }
}, 10_000);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
