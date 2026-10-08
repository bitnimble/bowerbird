// Uploads a signed AAB to a Play track and rolls it out there, through one Play Developer API edit.
//
//   PLAY_ACCESS_TOKEN=... bun run scripts/play-upload.ts <package> <aab> <track>
import { argv, env } from 'node:process';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

const [pkg, aab, track] = argv.slice(2);
const token = env.PLAY_ACCESS_TOKEN;
if (pkg == null || aab == null || track == null) {
  throw new Error('usage: play-upload.ts <package> <aab> <track>');
}
if (token == null || token === '') throw new Error('PLAY_ACCESS_TOKEN is not set');

async function play<T>(method: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} answered ${response.status}:\n${await response.text()}`);
  }
  return (await response.json()) as T;
}

const edits = `${API}/${pkg}/edits`;
const { id } = await play<{ id: string }>('POST', edits);
const { versionCode } = await play<{ versionCode: number }>(
  'POST',
  `${UPLOAD}/${pkg}/edits/${id}/bundles?uploadType=media`,
  { body: Bun.file(aab), headers: { 'content-type': 'application/octet-stream' } },
);
await play('PUT', `${edits}/${id}/tracks/${track}`, {
  body: JSON.stringify({
    track,
    releases: [{ versionCodes: [String(versionCode)], status: 'completed' }],
  }),
  headers: { 'content-type': 'application/json' },
});
await play('POST', `${edits}/${id}:commit`);
console.log(`version code ${versionCode} is on ${pkg}'s ${track} track`);
