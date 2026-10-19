import type { LogLevel } from '../schemas/settings';

const GRID_RENDITION = /^\/image\/[^/]+\/renditions\/grid$/;

export function requestLogLevel({
  status,
  method,
  path,
  ms,
  activity,
}: {
  status: number;
  method: string;
  path: string;
  ms: number;
  activity?: string;
}): LogLevel {
  if (status >= 500) return 'error';
  if (status === 404 && method === 'GET' && GRID_RENDITION.test(path)) return 'debug';
  if (status >= 400) return 'warn';
  if (activity === 'interactive') return 'info';
  if (activity === 'background') return 'debug';
  if (
    method === 'GET' &&
    /^\/image\/[^/]+\/(?:download\/(?:original|embedded|full|max)|share\/(?:embedded|full|max)|prepare|analysis)$/.test(
      path,
    )
  )
    return 'info';
  if (
    method === 'GET' &&
    (path === '/api/events' || GRID_RENDITION.test(path) || /^\/image\/exports\/[^/]+$/.test(path))
  )
    return 'debug';
  return method !== 'GET' || ms >= 1_000 ? 'info' : 'debug';
}
