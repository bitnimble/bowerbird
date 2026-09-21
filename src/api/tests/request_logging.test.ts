import { expect, test } from 'bun:test';
import { requestLogLevel } from '../request_logging';

test.each([
  { method: 'GET', path: '/api/photos/photo', ms: 2, activity: 'interactive', expected: 'info' },
  { method: 'POST', path: '/api/photos/neighbours', ms: 2000, activity: 'background', expected: 'debug' },
  { method: 'GET', path: '/api/libraries/library/photos', ms: 2000, activity: 'background', expected: 'debug' },
  { method: 'GET', path: '/image/photo/renditions/grid', ms: 2000, expected: 'debug' },
  { method: 'GET', path: '/image/exports/export-id', ms: 2000, expected: 'debug' },
  { method: 'GET', path: '/api/events', ms: 2000, expected: 'debug' },
  { method: 'GET', path: '/image/photo/download/original', ms: 2000, expected: 'info' },
  { method: 'GET', path: '/image/photo/prepare', ms: 2000, expected: 'info' },
  { method: 'GET', path: '/image/photo/download/original', ms: 2, expected: 'info' },
  { method: 'GET', path: '/image/photo/download/full', ms: 2, expected: 'info' },
  { method: 'GET', path: '/image/photo/share/full', ms: 2, expected: 'info' },
  { method: 'GET', path: '/image/photo/prepare', ms: 2, expected: 'info' },
  { method: 'GET', path: '/image/photo/analysis', ms: 2, expected: 'info' },
  { method: 'GET', path: '/image/photo/renditions/grid', ms: 2, expected: 'debug' },
  { method: 'POST', path: '/api/photos', ms: 2, expected: 'info' },
  { method: 'GET', path: '/api/photos/photo', ms: 2, activity: 'unknown', expected: 'debug' },
])('request logging follows purpose: $method $path $activity', ({ expected, ...request }) => {
  expect(requestLogLevel({ ...request, status: 200 })).toBe(expected);
  expect(requestLogLevel({ ...request, status: 404 })).toBe('warn');
  expect(requestLogLevel({ ...request, status: 500 })).toBe('error');
});
