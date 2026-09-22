import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../packages/client/ui-theme/src/styles/base.css'
import '../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../packages/client/ui-theme/src/styles/scrollbar.css'
import { App } from './App.tsx'
import './global.css'

const root = document.getElementById('root')
if (root === null) throw new Error('public observatory: missing #root')
createRoot(root).render(<StrictMode><App /></StrictMode>)
