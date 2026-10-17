import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'normalize.css'
import './index.css'
import App from './App.tsx'
import { installInterfaceSounds } from './lib/sounds'

const disposeSounds = installInterfaceSounds()
if (import.meta.hot) import.meta.hot.dispose(disposeSounds)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
