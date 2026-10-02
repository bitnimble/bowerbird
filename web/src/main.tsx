import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';
import { App } from './app/app';
import { shellScreen } from './app/device';
import { openDeviceStorage } from './app/local_setting';
import { pageLog } from './features/logs/page_log';
import { restoreUiScale } from './features/settings/device_settings_presenter';
import { StoresProvider } from './app/stores_context';
import { gpuThread } from './gpu/gpu_thread';
import { color, font, size } from './ui/tokens.stylex';
import { TooltipProvider } from './ui/tooltip';
import './app/global.css';

pageLog.follow();
// Before the GPU thread, whose pipeline recipes are among this device's files, and before the
// first render, whose state is built from this device's preferences.
const storage = openDeviceStorage().then(() => {
  gpuThread();
  return restoreUiScale().catch(() => undefined);
});

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

// Before the first render, so a stage opened straight away is not drawn in SDR first, and the
// page is not laid out once at the wrong scale.
void Promise.all([storage, shellScreen.follow()]).then(() =>
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
