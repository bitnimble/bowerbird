import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';
import { App } from './app/app';
import { StoresProvider } from './app/stores_context';
import { gpuThread } from './gpu/gpu_thread';
import { color, font, size } from './ui/tokens.stylex';
import { TooltipProvider } from './ui/tooltip';
import './app/global.css';

gpuThread();

const styles = stylex.create({
  body: {
    backgroundColor: color.ink,
    color: color.bone,
    fontFamily: font.body,
    fontSize: size.bodyText,
    WebkitFontSmoothing: 'antialiased',
  },
});

document.body.className = stylex.props(styles.body).className ?? '';

const root = document.getElementById('root');
if (root == null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <StoresProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </StoresProvider>
    </BrowserRouter>
  </StrictMode>,
);
