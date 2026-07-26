import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/app';
import { StoresProvider } from './app/stores_context';
import './app/styles.css';

const root = document.getElementById('root');
if (root == null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <StoresProvider>
        <App />
      </StoresProvider>
    </BrowserRouter>
  </StrictMode>,
);
