import { expect, test } from '@playwright/test';

// The GPU tick against the CPU it replaces (`docs/raw-edit-gpu.md` §6.3).
//
// This is the pin the whole conversion rests on: the shaders are a second implementation
// of one picture, and DESIGN §21.1 records what happens when two implementations of one
// picture are allowed to drift - the editor lost the camera match, twice, silently. So
// `edit_fixture` writes what the CPU produces and this asserts the shaders reproduce it.
//
// Split by stage rather than pooled into one number, because the two halves promise
// different things: tone and colour are the editor's whole reason to exist and must land
// exactly, where `finish` is a denoise and a sharpen whose GPU order of accumulation
// cannot match the CPU's and does not need to.
//
// Chromium only. Firefox has WebGPU on Windows first and this box is Linux; the parity is
// a property of the shaders rather than of the engine, so one runtime proves it.
// Headless Chromium ships with WebGPU off and no GPU process; these are what turn both on
// against a real Vulkan adapter. `--ozone-platform=headless` because there is no display,
// and the GPU is reached through a render node rather than a surface.
test.use({
  launchOptions: {
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--ozone-platform=headless',
    ],
  },
});

test.describe('GPU tick parity', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebGPU, and one engine proves it');
  // Six fixtures, each a whole `finish` at 96x64, and a cold pipeline creation per case.
  test.setTimeout(180_000);

  test('the shaders reproduce the CPU frame', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));

    await page.goto('/e2e/gpu_parity.html');
    await page.waitForFunction(
      () => document.getElementById('out')?.textContent !== 'waiting',
      null,
      { timeout: 120_000 },
    );

    const report = JSON.parse((await page.textContent('#out')) ?? '{}');
    expect(failures, failures.join('\n')).toHaveLength(0);
    // A box with no GPU is a skip rather than a failure: the shaders are what is under
    // test and an adapter is the harness.
    test.skip(report.ok === false && /adapter/.test(report.error ?? ''), 'no WebGPU adapter here');
    expect(report.ok, report.error).toBe(true);

    for (const [name, result] of Object.entries<Record<string, Record<string, number> | string>>(
      report.results,
    )) {
      expect(result.error, `${name}: ${String(result.error)}`).toBeUndefined();
      const grade = result.grade as Record<string, number>;
      const finish = result.finish as Record<string, number>;

      // Tone and colour are the promise, so the grade is held to arithmetic noise: what is
      // left is f32 against the CPU's f64 either side of the u16 the two stages join at.
      // Measured at 8 counts of 65535 at worst, and a mean nearer a tenth of one.
      expect(grade.worst, `${name} grade worst`).toBeLessThanOrEqual(16);
      expect(grade.mean, `${name} grade mean`).toBeLessThanOrEqual(0.5);

      // `finish` may not match exactly and does not need to (§6.3): a 65-tap box mean
      // summed in a different order and ten Richardson-Lucy iterations after it cannot
      // reproduce the CPU bit for bit on any hardware. Measured at 12 counts at worst.
      expect(finish.worst, `${name} finish worst`).toBeLessThanOrEqual(32);
      expect(finish.mean, `${name} finish mean`).toBeLessThanOrEqual(1);
    }
  });
});
