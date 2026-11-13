import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/base.css';
// Same page layout as the Backup page (.page, .page-header, .backup-section, .import-issues).
import '../backup/backup.css';
import './boards.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
