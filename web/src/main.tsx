import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';
import { App } from './app/app';
import { shellScreen } from './app/device';
import { pageLog } from './features/logs/page_log';
import { StoresProvider } from './app/stores_context';
import { gpuThread } from './gpu/gpu_thread';
import { color, font, size } from './ui/tokens.stylex';
import { TooltipProvider } from './ui/tooltip';
import './app/global.css';

pageLog.follow();
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

// Before the first render, so a stage opened straight away is not drawn in SDR first.
void shellScreen.follow().then(() =>
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
  ),
);
