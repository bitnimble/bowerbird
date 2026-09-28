import { expect, test } from 'bun:test';
import { AddReplicaRequestSchema } from '../replication';

const request = { address: 'http://peer', library_id: 'library1', sync_originals: true };

test.each(['/fixture/Trip ', 'C:\\Photos\\Trip '])('a replica preserves its literal folder path: %s', (root_path) => {
  expect(AddReplicaRequestSchema.parse({ ...request, root_path }).root_path).toBe(root_path);
});

test.each(['', ' \t '])('a replica refuses an empty folder path: %j', (root_path) => {
  expect(AddReplicaRequestSchema.safeParse({ ...request, root_path }).success).toBe(false);
});
