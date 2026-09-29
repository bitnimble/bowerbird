import { z } from 'zod';
import { shellInvoke } from '../../api/transport';
import { pageLog, type PageLog } from './page_log';

/** The shell's lines and the page's, in the order they were written. */
export async function appLog(page: PageLog = pageLog): Promise<string[]> {
  const shell = await shellLines();
  // Every line opens with an ISO timestamp, so text order is time order.
  return [...shell, ...page.recent()].sort((a, b) =>
    stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0,
  );
}

async function shellLines(): Promise<string[]> {
  const invoke = shellInvoke();
  if (invoke == null) return [];
  try {
    return z.array(z.string()).parse(await invoke('app_logs', {}));
  } catch {
    return [];
  }
}

const stamp = (line: string): string => line.slice(0, 24);
