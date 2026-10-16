import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ShellMediaListing } from '../media_listing';
import { FakeShell } from './fake_shell';

let shell: FakeShell;

beforeEach(() => {
  shell = new FakeShell();
});

afterEach(() => {
  shell.close();
});

describe('ShellMediaListing', () => {
  it('asks the shell for the folder and keys what it knows by path', async () => {
    await shell.answer(
      JSON.stringify({
        media: [
          [
            '/storage/emulated/0/DCIM/Camera/PXL_1.jpg',
            4_200_000,
            4032,
            3024,
            90,
            1_760_000_000_000,
            41,
          ],
          ['/storage/emulated/0/DCIM/Camera/notes.txt', 12, null, null, null, null, null],
        ],
      }),
    );
    const listed = await new ShellMediaListing(shell.socket).under('/storage/emulated/0/DCIM');
    expect(shell.asked).toEqual([{ list_media: '/storage/emulated/0/DCIM' }]);
    expect(listed).toEqual(
      new Map([
        [
          '/storage/emulated/0/DCIM/Camera/PXL_1.jpg',
          {
            size: 4_200_000,
            width: 4032,
            height: 3024,
            orientationDegrees: 90,
            takenWallMs: 1_760_000_000_000,
            imageId: 41,
          },
        ],
        [
          '/storage/emulated/0/DCIM/Camera/notes.txt',
          {
            size: 12,
            width: null,
            height: null,
            orientationDegrees: null,
            takenWallMs: null,
            imageId: null,
          },
        ],
      ]),
    );
  });

  it('reads an empty folder as an empty listing', async () => {
    await shell.answer('{"media":[]}');
    expect(await new ShellMediaListing(shell.socket).under('/empty')).toEqual(new Map());
  });

  it('answers null when the shell reports an error', async () => {
    await shell.answer('{"error":"could not list the device\'s media: no permission"}');
    expect(await new ShellMediaListing(shell.socket).under('/a')).toBeNull();
  });

  it('answers null for a reply it cannot read', async () => {
    await shell.answer('not json');
    expect(await new ShellMediaListing(shell.socket).under('/a')).toBeNull();
  });

  it('answers null for a row of the wrong shape', async () => {
    await shell.answer('{"media":[["/a.jpg",null,1,1,0,0,null]]}');
    expect(await new ShellMediaListing(shell.socket).under('/a')).toBeNull();
  });

  it('answers null when the shell closes without answering', async () => {
    await shell.answer(null);
    expect(await new ShellMediaListing(shell.socket).under('/a')).toBeNull();
  });

  it('answers null when no shell is listening', async () => {
    expect(await new ShellMediaListing(shell.socket).under('/a')).toBeNull();
  });
});

describe('ShellMediaListing.thumbnail', () => {
  it('asks for the image and hands back its bytes', async () => {
    await shell.answer(
      JSON.stringify({ jpeg: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }),
    );
    const jpeg = await new ShellMediaListing(shell.socket).thumbnail(41, '/a/p.jpg');
    expect(shell.asked).toEqual([{ thumbnail: [41, '/a/p.jpg'] }]);
    expect(jpeg).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('answers gone when the shell reports it has none', async () => {
    await shell.answer('{"gone":true}');
    expect(await new ShellMediaListing(shell.socket).thumbnail(41, '/a/p.jpg')).toBe('gone');
  });

  it('answers null when the shell could not read it', async () => {
    await shell.answer('{"error":"could not read the device\'s thumbnail: busy"}');
    expect(await new ShellMediaListing(shell.socket).thumbnail(41, '/a/p.jpg')).toBeNull();
  });

  it('answers null when no shell is listening', async () => {
    expect(await new ShellMediaListing(shell.socket).thumbnail(41, '/a/p.jpg')).toBeNull();
  });
});

describe('ShellMediaListing.queueThumbnail', () => {
  const jpeg = JSON.stringify({ jpeg: Buffer.from([0xff]).toString('base64') });
  const ask = (listing: ShellMediaListing, at: number): Promise<Uint8Array | 'gone' | null> =>
    listing.queueThumbnail(at, `/a/${at}.jpg`);

  it('answers every ask', async () => {
    await shell.answer(jpeg);
    const listing = new ShellMediaListing(shell.socket);
    const answers = await Promise.all(Array.from({ length: 9 }, (_, at) => ask(listing, at)));
    expect(answers.every((answer) => answer instanceof Uint8Array)).toBe(true);
    expect(shell.asked).toHaveLength(9);
  });

  it('asks 4 at a time, and the newest waiting next', async () => {
    await shell.answer(jpeg, { held: true });
    const listing = new ShellMediaListing(shell.socket);
    const answers = Array.from({ length: 6 }, (_, at) => ask(listing, at));
    while (shell.asked.length < 4) await Bun.sleep(1);
    await Bun.sleep(20);
    expect(shell.asked).toHaveLength(4);
    shell.release();
    await answers[0];
    while (shell.asked.length < 5) await Bun.sleep(1);
    expect(shell.asked[4]).toEqual({ thumbnail: [5, '/a/5.jpg'] });
    let settled = false;
    void Promise.all(answers).then(() => (settled = true));
    while (!settled) {
      shell.release();
      await Bun.sleep(1);
    }
    expect(shell.asked).toHaveLength(6);
  });
});
