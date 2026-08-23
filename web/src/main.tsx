import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted (not a Google Fonts CDN link) so the UI renders identically
// offline — matching the point of the app it's dressing.
import '@fontsource/victor-mono/400.css'
import '@fontsource/victor-mono/400-italic.css'
import '@fontsource/victor-mono/500.css'
import '@fontsource/victor-mono/600.css'
import '@fontsource/victor-mono/700.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
