import { StrictMode } from 'react'
import './i18n'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadBusinessRules } from './lib/businessRules'

void loadBusinessRules()

// After a release the old page files are gone: a tab opened before it cannot load the next page and stayed stuck on Loading.
// Reload once to pick up the new release (guarded so a real failure does not loop).
window.addEventListener('vite:preloadError', (event) => {
  const key = 'skyline-reloaded-for-release'
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})
window.addEventListener('load', () => { window.setTimeout(() => sessionStorage.removeItem('skyline-reloaded-for-release'), 10000) })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
