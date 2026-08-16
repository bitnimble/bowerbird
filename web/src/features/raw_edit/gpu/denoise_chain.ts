// The editor's denoise, dispatched.
//
// Eight passes over the frame, run when a Detail slider moves rather than per tick. The
// kernels are in `wgsl/galosh/`; this is the host that binds them, and it is the client's
// counterpart to `native/rawshim/src/galosh.rs` - a different denoiser on a different domain,
// deliberately (DESIGN 10.9.1).
//
// The order is the reference's YUV front-end, with the shrinkage and the inverse table taken
// from the mosaic path unchanged:
//
//   split -> GAT -> normalise -> build the inverse table -> shrink
//         -> denormalise -> invert -> chroma regression -> join
//
// **Nothing here measures the noise.** The frame arrives with its own noise curve attached,
// measured where it was built (`native/rawshim/src/noise.rs`), and that is not a saving so
// much as the only way to get the answer right: the estimator bins every block in the frame
// by its level and keeps the quiet tail of each bin, which is a whole-frame reduction the
// tick would have to repeat on every slider move. What it buys is a sigma per level rather
// than one per frame, and in PQ the difference is not small - a frame's noise against level
// is a hump, so one number is far under the truth in the shadows and far over it in the
// highlights. Over is the direction that hurts, because the shrinkage zeroes a block outright
// once its deviation falls to the assumed noise.
//
// **The chroma regression's guide is the noisy stabilised luma, not the shrunk one.** That
// looks like a bug and is not: the bilateral weight is deciding which neighbours belong to
// the same surface, and a denoised guide has already made that decision - following it
// applies the shrinkage's mistakes to the colour as well. So `y_stab` has to survive the
// shrinkage, which is why that writes to a plane of its own.

import { GALOSH } from './shaders';

/** One dispatch's scalars. WGSL has no push constants, so each gets a slot of its own. */
const SLOT = 256;

/** `params` indices, as `prelude.wgsl` names them, plus the slot the scaling reads. */
const P_ALPHA = 13;
const P_SIGMA_SQ = 14;
const P_SIGMA_GAT = 21;

/** The chroma regression's window, its workgroup, and the shrinkage's tile. */
const LOESS_RADIUS = 7;
const LOESS_GROUP = 16;
const PASS12_TILE = 28;

/**
 * The rows one `record` covers, a whole number of `pass12` tiles and of regression workgroups.
 *
 * A band that split either would be a band that re-anchored a grid: `pass12`'s shrinkage is
 * defined over tiles from the frame's origin, and a regression group that straddled two bands
 * would write rows the next band has not prepared its neighbourhood for. Being even also lands
 * `yuv_join`'s pairs, whose unit is two pixels and whose band therefore has to start on one.
 */
const BAND_ROWS = 112;

/**
 * The rows a band's neighbourhood reaches past it, which is the widest gather below the flat
 * passes: the regression's 7, over `pass12`'s 6.
 */
const HALO_ROWS = LOESS_RADIUS;

export interface DenoiseAmounts {
  luma: number;
  blend: number;
  ridge: number;
}

/**
 * The frame's own noise, as `crate::noise::Noise` measured it.
 *
 * `stabilised` is the sigma of the *transformed* luma for a typical block of this frame, which
 * is what the plane is divided by so the shrinkage's thresholds land in units of one sigma.
 */
export interface NoiseCurve {
  stabilised: number;
  alpha: number;
  sigmaSq: number;
}

export interface DenoiseChain {
  /** Everything to destroy with the pipeline. */
  planes: GPUBuffer[];
  /** How many `record` calls a whole frame takes, band 0 first. */
  bands: number;
  /**
   * One band's dispatches. Submit each on its own and the picture arrives in strips rather than
   * after the whole frame, which is what makes a Detail slider feel answered.
   *
   * The bands of one sweep have to be recorded in order and none of them skipped: each prepares
   * the neighbourhood the next one gathers over, and a band abandoned part way leaves the chain
   * saying it owes the luma again.
   */
  record(encoder: GPUCommandEncoder, amounts: DenoiseAmounts, band: number): void;
}

type Binding = 'read' | 'write' | 'uniform';

export function buildDenoiseChain(
  device: GPUDevice,
  frame: GPUBuffer,
  denoised: GPUBuffer,
  width: number,
  height: number,
  noise: NoiseCurve,
): DenoiseChain {
  const npix = width * height;
  const plane = (label: string) =>
    device.createBuffer({ label, size: npix * 4, usage: GPUBufferUsage.STORAGE });
  const small = (label: string, floats: number) =>
    device.createBuffer({ label, size: floats * 4, usage: GPUBufferUsage.STORAGE });

  const y = plane('denoise Y');
  const cb = plane('denoise Cb');
  const cr = plane('denoise Cr');
  const yStab = plane('denoise Y stabilised');
  // The shrinkage's output, and later the regression's first channel: nothing reads the
  // shrunk luma once it has been inverted, and a plane at the prepared size is not free.
  const yDen = plane('denoise Y shrunk / Cb out');
  const crOut = plane('denoise Cr out');
  // Written from here rather than by a kernel, which is what the measurement moving to the
  // server means: `alpha` and `sigma_sq` used to be a dispatch's output.
  const params = device.createBuffer({
    label: 'denoise params',
    size: 32 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const lutD = small('denoise lut d', 4096);
  const lutX = small('denoise lut x', 4096);
  const lutParams = small('denoise lut params', 8);
  const planes = [y, cb, cr, yStab, yDen, crOut, params, lutD, lutX, lutParams];

  // Once, at build: the frame's noise does not change when a slider moves.
  const constants = new Float32Array(32);
  constants[P_ALPHA] = noise.alpha;
  constants[P_SIGMA_SQ] = noise.sigmaSq;
  constants[P_SIGMA_GAT] = noise.stabilised;
  device.queue.writeBuffer(params, 0, constants);

  const COMPUTE = GPUShaderStage.COMPUTE;
  const layoutOf = (kinds: [number, Binding][]) =>
    device.createBindGroupLayout({
      entries: kinds.map(([binding, kind]) => ({
        binding,
        visibility: COMPUTE,
        buffer:
          kind === 'uniform'
            ? ({ type: 'uniform', hasDynamicOffset: true } as const)
            : ({ type: kind === 'read' ? 'read-only-storage' : 'storage' } as const),
      })),
    });

  const pipelineOf = (code: string, entryPoint: string, layout: GPUBindGroupLayout) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code, label: entryPoint }), entryPoint },
    });

  const splitLayout = layoutOf([[0, 'read'], [1, 'write'], [2, 'write'], [3, 'write'], [20, 'uniform']]);
  const gatLayout = layoutOf([[0, 'read'], [1, 'write'], [2, 'read'], [20, 'uniform']]);
  const scaleLayout = layoutOf([[0, 'write'], [1, 'read'], [20, 'uniform']]);
  const lutLayout = layoutOf([[0, 'read'], [1, 'write'], [2, 'write'], [3, 'write']]);
  const lutFinLayout = layoutOf([[0, 'read'], [1, 'write']]);
  const shrinkLayout = layoutOf([[0, 'read'], [1, 'write'], [20, 'uniform']]);
  const inverseLayout = layoutOf([
    [0, 'read'], [1, 'write'], [2, 'read'], [3, 'read'], [4, 'read'], [20, 'uniform'],
  ]);
  const loessLayout = layoutOf([
    [0, 'read'], [1, 'read'], [2, 'read'], [3, 'write'], [4, 'write'], [20, 'uniform'],
  ]);
  const joinLayout = layoutOf([[0, 'read'], [1, 'read'], [2, 'read'], [3, 'write'], [20, 'uniform']]);

  const pipelines = {
    split: pipelineOf(GALOSH.split, 'yuv_split', splitLayout),
    gat: pipelineOf(GALOSH.gatFwd, 'yuv_gat_fwd', gatLayout),
    norm: pipelineOf(GALOSH.sigmaScale, 'yuv_sigma_norm', scaleLayout),
    denorm: pipelineOf(GALOSH.sigmaScale, 'yuv_sigma_denorm', scaleLayout),
    lut: pipelineOf(GALOSH.buildInvLut, 'build_inv_lut', lutLayout),
    lutFin: pipelineOf(GALOSH.lutFinalize, 'lut_finalize', lutFinLayout),
    shrink: pipelineOf(GALOSH.pass12, 'pass12', shrinkLayout),
    invert: pipelineOf(GALOSH.makitalo, 'yuv_makitalo', inverseLayout),
    loess: pipelineOf(GALOSH.loess, 'yuv_loess', loessLayout),
    join: pipelineOf(GALOSH.join, 'yuv_join', joinLayout),
  };

  const bind = (layout: GPUBindGroupLayout, buffers: [number, GPUBuffer][], slot: number | null) =>
    device.createBindGroup({
      layout,
      entries: [
        ...buffers.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
        ...(slot == null
          ? []
          : [{ binding: 20, resource: { buffer: uniform, offset: 0, size: SLOT } }]),
      ],
    });

  // One per dispatch that takes scalars; the two table kernels take none.
  const SLOTS = 8;
  const uniform = device.createBuffer({
    label: 'denoise pushes',
    size: SLOTS * SLOT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  planes.push(uniform);

  const groups = {
    split: bind(splitLayout, [[0, frame], [1, y], [2, cb], [3, cr]], 0),
    gat: bind(gatLayout, [[0, y], [1, yStab], [2, params]], 1),
    norm: bind(scaleLayout, [[0, yStab], [1, params]], 2),
    lut: bind(lutLayout, [[0, params], [1, lutD], [2, lutX], [3, lutParams]], null),
    lutFin: bind(lutFinLayout, [[0, lutD], [1, lutParams]], null),
    shrink: bind(shrinkLayout, [[0, yStab], [1, yDen]], 3),
    denorm: bind(scaleLayout, [[0, yDen], [1, params]], 4),
    invert: bind(inverseLayout, [[0, yDen], [1, y], [2, lutD], [3, lutX], [4, lutParams]], 5),
    loess: bind(loessLayout, [[0, yStab], [1, cb], [2, cr], [3, yDen], [4, crOut]], 6),
    join: bind(joinLayout, [[0, y], [1, yDen], [2, crOut], [3, denoised]], 7),
  };

  const over = (count: number, by: number) => Math.max(1, Math.ceil(count / by));
  /**
   * A flat sweep as a 2D grid, because one dimension does not hold a frame: at 24MP a
   * 256-wide workgroup wants 94,690 of them against the 65,535 a dimension allows. The
   * kernels fold the second dimension back in through `flat_index`.
   */
  const spread = (invocations: number): [number, number] => {
    const wanted = over(invocations, 256);
    const wide = Math.max(1, device.limits.maxComputeWorkgroupsPerDimension);
    const x = Math.max(1, Math.min(wanted, wide));
    return [x, Math.max(1, Math.ceil(wanted / x))];
  };
  const acrossGroups = over(width, LOESS_GROUP);
  const acrossTiles = over(width, PASS12_TILE);
  const bands = Math.max(1, Math.ceil(height / BAND_ROWS));

  // The luma the planes below `loess` currently hold, or null where no sweep has finished at it.
  let shrunkAt: number | null = null;
  let from: 'split' | 'loess' = 'split';
  // The row the flat passes have reached, which is a band's own end plus the halo the next one
  // will gather over. They are not all idempotent - `yuv_sigma_norm` scales in place - so the
  // overlap between two bands' neighbourhoods has to be run once, not twice.
  let prepared = 0;

  return {
    planes,
    bands,
    record(encoder, amounts, band) {
      if (band === 0) {
        // **A colour-only tick resumes at the regression.** `luma` is the only amount that enters
        // before it - `ridge` and `blend` are the regression's own - and nothing from `loess` on
        // writes a plane the passes before it read, so their output is still this frame's.
        // Skipping them is what makes the colour slider interactive rather than a five-second
        // wait.
        from = shrunkAt === amounts.luma ? 'loess' : 'split';
        // Only a finished sweep can claim the planes: a slider moved again part way through
        // abandons the bands below this one, and they still hold the previous luma.
        shrunkAt = null;
        prepared = 0;
      }
      const y0 = band * BAND_ROWS;
      const y1 = Math.min(y0 + BAND_ROWS, height);
      if (band === bands - 1) shrunkAt = amounts.luma;

      const flatFrom = prepared * width;
      const flatTo = Math.min((y1 + HALO_ROWS) * width, npix);
      prepared = Math.min(y1 + HALO_ROWS, height);
      const bandFrom = y0 * width;
      const bandTo = Math.min(y1 * width, npix);

      // One write per band, which is sound because `writeBuffer` lands before the command buffer
      // recorded alongside it: no two passes here want different values in a slot.
      const scalars = new ArrayBuffer(SLOTS * SLOT);
      const ints = new Int32Array(scalars);
      const floats = new Float32Array(scalars);
      const at = (slot: number) => (slot * SLOT) / 4;
      ints.set([flatTo, flatFrom], at(0));
      ints.set([flatTo, flatFrom], at(1));
      ints.set([flatTo, P_SIGMA_GAT, flatFrom], at(2));
      ints.set([width, height], at(3));
      floats[at(3) + 2] = amounts.luma;
      ints[at(3) + 3] = y0 / PASS12_TILE;
      ints.set([bandTo, P_SIGMA_GAT, bandFrom], at(4));
      ints.set([bandTo, bandFrom], at(5));
      ints.set([width, height], at(6));
      floats[at(6) + 2] = amounts.ridge;
      floats[at(6) + 3] = amounts.blend;
      ints.set([LOESS_RADIUS, y0], at(6) + 4);
      ints.set([bandTo, bandFrom / 2], at(7));
      device.queue.writeBuffer(uniform, 0, scalars);

      const pass = encoder.beginComputePass({ label: 'denoise' });
      const run = (
        pipeline: GPUComputePipeline,
        group: GPUBindGroup,
        slot: number | null,
        [x, yGroups]: [number, number],
      ) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group, slot == null ? [] : [slot * SLOT]);
        pass.dispatchWorkgroups(x, yGroups);
      };

      if (from === 'split') {
        if (flatTo > flatFrom) {
          const ahead = spread(flatTo - flatFrom);
          run(pipelines.split, groups.split, 0, ahead);
          run(pipelines.gat, groups.gat, 1, ahead);
          run(pipelines.norm, groups.norm, 2, ahead);
        }
        // The inverse table is a function of the frame's noise and of nothing else, so it is one
        // dispatch for the sweep rather than one per band.
        if (band === 0) {
          run(pipelines.lut, groups.lut, null, [16, 1]);
          run(pipelines.lutFin, groups.lutFin, null, [1, 1]);
        }
        const own = spread(bandTo - bandFrom);
        run(pipelines.shrink, groups.shrink, 3, [acrossTiles, over(y1 - y0, PASS12_TILE)]);
        run(pipelines.denorm, groups.denorm, 4, own);
        run(pipelines.invert, groups.invert, 5, own);
      }
      run(pipelines.loess, groups.loess, 6, [acrossGroups, over(y1 - y0, LOESS_GROUP)]);
      // Two pixels an invocation, which is what makes the pack race-free.
      run(pipelines.join, groups.join, 7, spread(Math.ceil(bandTo / 2) - bandFrom / 2));
      pass.end();
    },
  };
}
