import type { LogLevel } from '../schemas/settings';

export function requestLogLevel({ status, method, path, ms, activity }: {
  status: number;
  method: string;
  path: string;
  ms: number;
  activity?: string;
}): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (activity === 'interactive') return 'info';
  if (activity === 'background') return 'debug';
  if (method === 'GET' && /^\/image\/[^/]+\/(?:download\/(?:original|embedded|full|max)|share\/(?:embedded|full|max)|prepare|analysis)$/.test(path)) return 'info';
  if (method === 'GET' && (path === '/api/events' || /^\/image\/(?:[^/]+\/renditions\/grid(?:\/|$)|exports\/[^/]+$)/.test(path))) return 'debug';
  return method !== 'GET' || ms >= 1_000 ? 'info' : 'debug';
}
