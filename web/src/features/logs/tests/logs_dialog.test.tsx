import { afterEach, expect, test } from 'bun:test';
import { logsApi } from '../../../api/logs';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
restoreApiAfterTests();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { LogsDialog } = await import('../logs_dialog');

afterEach(cleanup);

test('opens on the server, and offers each peer and this app beside it', async () => {
  logsApi.server = async () => ({ name: 'Studio', lines: ['server started', 'scan done'] });
  logsApi.peers = async () => ({
    peers: [
      { peer_id: 'nas', name: 'NAS', lines: ['from the peer'] },
      { peer_id: 'gone', name: 'Old laptop', lines: null },
    ],
  });
  render(<LogsDialog open onOpenChange={() => {}} />);
  await act(async () => {});

  expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
    'Studio',
    'NAS',
    'Old laptop',
    'This app',
  ]);
  expect(screen.getByRole('log', { name: 'Studio' }).textContent).toBe('server started\nscan done');

  fireEvent.click(screen.getByRole('radio', { name: 'NAS' }));
  expect(screen.getByRole('log', { name: 'NAS' }).textContent).toBe('from the peer');

  fireEvent.click(screen.getByRole('radio', { name: 'Old laptop' }));
  expect(
    screen.getByText("We couldn't reach Old laptop. Check it's on the same network."),
  ).toBeTruthy();
});

test('says so when the server cannot be read', async () => {
  logsApi.server = async () => {
    throw new Error('offline');
  };
  logsApi.peers = async () => ({ peers: [] });
  render(<LogsDialog open onOpenChange={() => {}} />);
  await act(async () => {});

  expect(screen.getByRole('radio', { name: 'Server' })).toBeTruthy();
  expect(screen.getByText("We couldn't load these logs. Try again in a moment.")).toBeTruthy();
});
