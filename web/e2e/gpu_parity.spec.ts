import { expect, test } from '@playwright/test';

// The browser's grade against the graded answer the server produces (`docs/raw-edit-gpu.md`
// §6.3).
//
// This is the pin the whole conversion rests on: the client runs a second implementation of
// one picture, and DESIGN §21.1 records what happens when two implementations of one picture
// are allowed to drift - the editor lost the camera match, twice, silently.
//
// Half the pin, and the half that runs the *client's* upload path. It asserts the browser
// reproduces the bytes in `fixtures/gpu/`; the other half,
// `native/rawshim/tests/gpu_fixture.rs`, keeps those bytes current inside `cargo test`. Both
// halves are needed and neither subsumes the other: the Rust side builds its own bindings, so
// only this one can catch the client packing a lattice differently - which it did, silently
// dropping the ninth value of every node until this spec failed.
//
// Split by stage rather than pooled into one number, because the two halves promise
// different things: tone and colour are the editor's whole reason to exist and must land
// exactly, where `finish` is a denoise and a sharpen whose GPU order of accumulation
// cannot match the CPU's and does not need to.
//
// **What this is still for, now `native/rawshim/tests/gpu_shader.rs` exists.** That test
// compiles the same WGSL against a Vulkan adapter and checks its arithmetic against
// `hdr_fit` in 40ms of `cargo test`, so the shader maths no longer needs a browser to ask
// about - and should be asked there, on every edit. What only this can say is whether the
// *TypeScript* wires it up correctly: the payload deinterleave, the texture formats, the
// bind groups, the passes and their order. Both bugs have happened, and the second one is
// invisible to a shader that is perfectly correct about the data it is handed.
//
// So: run `gpu_shader` constantly and this before merging. It costs two cold servers and a
// Vite build, which is why it is not the loop to develop against.
//
// Chromium only. Firefox has WebGPU on Windows first and this box is Linux; the parity is
// a property of the shaders rather than of the engine, so one runtime proves it.
test.describe('GPU tick parity', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebGPU, and one engine proves it');
  // Six fixtures, each a whole `finish` at 96x64, and a cold pipeline creation per case.
  test.setTimeout(180_000);

  test('the browser reproduces the graded frame', async ({ page }) => {
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

    // Named, not counted: the loop below passes over an empty object, and over a report that
    // holds some other set of cases than the six the fixtures pin.
    expect(Object.keys(report.results ?? {}).sort()).toEqual([
      'tick-matched-ev-1.5',
      'tick-matched-ev0',
      'tick-matched-ev1',
      'tick-neutral-ev-1.5',
      'tick-neutral-ev0',
      'tick-neutral-ev1',
    ]);

    for (const [name, result] of Object.entries<Record<string, number | string>>(report.results)) {
      expect(result.error, `${name}: ${String(result.error)}`).toBeUndefined();
      // The mean is the assertion that matters, and it is the tight one: a wrong constant or
      // a wrong stage moves every pixel, so it lands here and nowhere else. When the matched
      // fixtures were still an identity transform this read 0.1; the wrong luma weights they
      // were hiding read 11.9.
      expect(result.mean as number, `${name} mean`).toBeLessThanOrEqual(0.5);
      // The worst is a handful of pixels rather than a picture, so it is bounded by count as
      // well as by size - and by band, because one number over the whole range is not a
      // bound on anything. PQ keeps most of its code space in the deep shadows: a sample at
      // 0.015 nits against a 1000-nit peak encodes near level 1735 and one at 0.04 near
      // 2413, so a disagreement of hundredths of a nit - which is what a last-bit f32
      // difference against the CPU's f64 amounts to there - reads as hundreds of counts and
      // is invisible. Above that band the same difference is a handful of counts, so that is
      // where the tolerance is worth spending.
      const bands = result.byBand as Record<string, { worst: number }>;
      expect(bands.shadow!.worst, `${name} worst in shadow`).toBeLessThanOrEqual(1024);
      expect(bands.mid!.worst, `${name} worst in mid`).toBeLessThanOrEqual(128);
      expect(bands.highlight!.worst, `${name} worst in highlight`).toBeLessThanOrEqual(128);
      expect(
        (result.over16 as number) / (result.samples as number),
        `${name} fraction past 16`,
      ).toBeLessThanOrEqual(0.005);
    }

    // The tick measures its scene peak off a kept set of the brightest pixels, chosen once
    // at neutral exposure. Both halves of that are assertable: the candidates have to agree
    // with a full sample of the frame at every position of the slider, and neither may
    // saturate the histogram they are binned into - a fixed top made the peak stop climbing
    // a couple of stops up, which reads as the highlights suddenly clipping.
    const sweep = report.results['tick-matched-ev0'].sweep as
      | { ev: number; candidates: number; full: number }[]
      | undefined;
    expect(sweep, 'the matched fixture reports a peak sweep').toBeDefined();
    const neutral = sweep?.find((point) => point.ev === 0)?.full ?? 0;
    expect(neutral, 'a peak at neutral exposure').toBeGreaterThan(0);

    // And that a tick is taking the shortcut those numbers are about. The candidates are read
    // only when they are every pixel that cleared the threshold; where more qualify than fit,
    // what is kept is the frame's top rows rather than a spread of it, and the tick reads the
    // frame instead. At 6144 samples against a cap of 16,384 this fixture cannot overflow, so
    // the answer has to be yes. If it silently became no the picture would be identical and
    // every tick would just pay the millisecond `collect` exists to save.
    expect(
      report.results['tick-matched-ev0'].readsCandidates,
      'the tick reads its peak off the candidates when they are exact',
    ).toBe(true);

    for (const { ev, candidates, full } of sweep ?? []) {
      expect(
        Math.abs(candidates - full) / full,
        `peak at ${ev} EV: candidates ${candidates} against a full sample's ${full}`,
      ).toBeLessThanOrEqual(0.02);
      // The exposure is a gain on the scene, so the peak it measures is that gain on the
      // peak at neutral. This is the assertion the histogram's top has to survive: bin the
      // values into a range that does not travel with the exposure and the count saturates,
      // which reads here as a peak that stops climbing - and in the picture as highlights
      // that clip a couple of stops up. At +5 EV this fixture measures 6594 nits against a
      // fixed top's 4872, so the failure is inside the slider's own range.
      // Upwards only, and because of the curve rather than the histogram: the tone curve
      // compresses, so below neutral the peak sits above the gain by a few percent. Above
      // neutral is where the highlights are and where saturating the histogram would show.
      if (ev < 0) continue;
      // The tolerance is loose because the model is allowed to break this proxy and the
      // failure it stands in for is not subtle. A chroma lattice that corrects lightness
      // per node means the peak cannot track the exposure exactly: the slider moves a
      // pixel's chroma, that lands it on different nodes, and it picks up a different
      // gain on the way. The 2x2 beside it has no such effect - it scales `d`, and `d`
      // scales with the exposure, so the ratio survives. Measured, this fixture sits at
      // 4.9% and a fitted frame's gains span 0.9685 to 1.0123, so a few percent is the
      // model working. A saturating histogram reads 6594 nits against 4872 at +5 EV,
      // which is 35% and nowhere near this line.
      expect(
        Math.abs(full / neutral - 2 ** ev) / 2 ** ev,
        `peak at ${ev} EV is ${full / neutral}x neutral, against 2^${ev}`,
      ).toBeLessThanOrEqual(0.1);
    }

    // And strictly rising across the whole slider, which is the shape both ways of getting
    // the histogram wrong break. Bins fixed at a few times reference saturate, so the peak
    // stops climbing; bins grown with the gain lose the values instead, because the curve
    // compresses faster than the range opens, and the peak falls towards nothing - which
    // reads on screen as the picture going dark and flat at particular slider positions.
    const peaks = (sweep ?? []).map((point) => point.full);
    for (let at = 1; at < peaks.length; at++) {
      expect(peaks[at]!, `the peak rises from ${sweep?.[at - 1]?.ev} to ${sweep?.[at]?.ev} EV`)
        .toBeGreaterThan(peaks[at - 1]!);
    }
  });
});
