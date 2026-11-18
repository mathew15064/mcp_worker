import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Do not mount StrictMode here: dev double effects could consume one-time
// OAuth credentials before they are displayed in the UI.
createRoot(document.getElementById('root')!).render(<App />)
