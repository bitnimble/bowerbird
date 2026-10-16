import { z } from 'zod';
import { logsApi } from '../../api/logs';
import { shellInvoke } from '../../api/transport';
import { LogsDialogStrings } from './logs_dialog.strings';

const SERVER_PATIENCE_MS = 3_000;

/** Falls back to the app's copy of the log file when the server doesn't answer in time; null if neither. */
export async function serverLog(
  patienceMs = SERVER_PATIENCE_MS,
): Promise<{ name: string; lines: string[] } | null> {
  const answered = await Promise.race([
    logsApi.server().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), patienceMs)),
  ]);
  if (answered != null) return answered;
  const invoke = shellInvoke();
  if (invoke == null) return null;
  try {
    const lines = z.array(z.string()).parse(await invoke('server_log_file', {}));
    return { name: LogsDialogStrings.serverLogFile(), lines };
  } catch {
    return null;
  }
}
