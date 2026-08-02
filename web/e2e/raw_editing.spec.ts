import { expect, test } from '@playwright/test';

test('starts an isolated multithreaded RAW editor worker', async ({ page }) => {
  await page.goto('/test-raw-editing');

  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  const available = await page.evaluate(() => navigator.hardwareConcurrency);
  const threads = page.getByTestId('raw-edit-threads');
  await expect(threads).toHaveText(String(Math.max(1, available)));
});

/**
 * The still route is HDR only because of four bytes, and a PNG that loses them is a
 * valid, ordinary, SDR picture - so every other check downstream of here would still
 * pass. This asserts on the bytes the browser was actually handed.
 *
 * Needs no RAW: the reference patches are built from the transfer function alone, which
 * is also what makes them a fair witness for the photograph graded beside them.
 */
test('tags the still route PQ, in the bytes the browser receives', async ({ page }) => {
  await page.goto('/test-raw-editing');

  const reference = page.getByAltText('203 and 1000 nit PQ reference patches');
  await expect(reference).toBeVisible();
  await expect
    .poll(() => reference.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(512);

  const chunks = await reference.evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const found: { kind: string; data: number[] }[] = [];
    // Past the 8-byte signature, then length/kind/data/CRC until the file runs out.
    for (let at = 8; at < bytes.length; ) {
      const length = view.getUint32(at);
      const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      found.push({ kind, data: [...bytes.subarray(at + 8, at + 8 + length)] });
      at += 12 + length;
    }
    return found;
  });

  const cicp = chunks.find((c) => c.kind === 'cICP');
  // BT.2020 primaries, the PQ transfer, identity matrix, full range.
  expect(cicp?.data).toEqual([9, 16, 0, 1]);
  // A decoder stops looking for colour once the pixels start.
  expect(chunks.findIndex((c) => c.kind === 'cICP')).toBeLessThan(
    chunks.findIndex((c) => c.kind === 'IDAT'),
  );
  expect(chunks.at(-1)?.kind).toBe('IEND');
});
