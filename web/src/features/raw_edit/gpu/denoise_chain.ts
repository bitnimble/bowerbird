// The editor's denoise, dispatched.
//
// Thirteen passes over the frame, run when a Detail slider moves rather than per tick. The
// kernels are in `wgsl/galosh/`; this is the host that binds them, and it is the client's
// counterpart to `native/rawshim/src/galosh.rs` - a different denoiser on a different domain,
// deliberately (DESIGN 10.9.1).
//
// The order is the reference's YUV front-end, with the shrinkage and the inverse table taken
// from the mosaic path unchanged:
//
//   split -> sigma(Y) -> alpha,sigma2 -> GAT -> sigma(Y_stab) -> normalise
//         -> build the inverse table -> shrink -> denormalise -> invert
//         -> chroma regression -> join
//
// Both sigmas are measured as an **envelope**: each 8x8 block's own median Laplacian, then
// the quietest tenth of the blocks. The reference's simpler estimator takes one median over
// the whole frame, and measured against this on real frames it reads 2.6 to 4.6 times high -
// on a detailed photograph the median pixel is not a quiet one. That matters more than it
// sounds, because the shrinkage zeroes a block outright once its deviation falls to the
// assumed noise, so an inflated sigma does not over-smooth by a little; it flattens.
//
// **The chroma regression's guide is the noisy stabilised luma, not the shrunk one.** That
// looks like a bug and is not: the bilateral weight is deciding which neighbours belong to
// the same surface, and a denoised guide has already made that decision - following it
// applies the shrinkage's mistakes to the colour as well. So `y_stab` has to survive the
// shrinkage, which is why that writes to a plane of its own.

import { GALOSH } from './shaders';

/** One dispatch's scalars. WGSL has no push constants, so each gets a slot of its own. */
const SLOT = 256;

/** `params` indices, as the kernels name them. */
const P_SIGMA_LINEAR = 20;
const P_SIGMA_GAT = 21;

/** The chroma regression's window, and the shrinkage's tile. */
const LOESS_RADIUS = 7;
const PASS12_TILE = 28;

export interface DenoiseAmounts {
  luma: number;
  blend: number;
}

/**
 * The ridge the chroma regression is damped by, which is not a control.
 *
 * The reference calls it `loess_strength` and runs it at 1.0, which is where the damping
 * matches the noise it fitted. The Colour slider mixes the regression's answer in against
 * the pixel's own instead: how *far* to trust a fit is a different question from how well
 * it is regularised, and only the first is a matter of taste.
 */
const LOESS_RIDGE = 1.0;

export interface DenoiseChain {
  /** Everything to destroy with the pipeline. */
  planes: GPUBuffer[];
  record(encoder: GPUCommandEncoder, amounts: DenoiseAmounts): void;
}

type Binding = 'read' | 'write' | 'uniform';

export function buildDenoiseChain(
  device: GPUDevice,
  frame: GPUBuffer,
  denoised: GPUBuffer,
  width: number,
  height: number,
): DenoiseChain {
  const npix = width * height;
  const plane = (label: string) =>
    device.createBuffer({ label, size: npix * 4, usage: GPUBufferUsage.STORAGE });
  const small = (label: string, floats: number) =>
    device.createBuffer({ label, size: floats * 4, usage: GPUBufferUsage.STORAGE });

  // One value per 8x8 block, which is what the envelope is taken over.
  const blocksWide = Math.max(1, Math.floor(width / 8));
  const blocksHigh = Math.max(1, Math.floor(height / 8));
  const blockCount = blocksWide * blocksHigh;

  const y = plane('denoise Y');
  const cb = plane('denoise Cb');
  const cr = plane('denoise Cr');
  const yStab = plane('denoise Y stabilised');
  // The shrinkage's output, and later the regression's first channel: nothing reads the
  // shrunk luma once it has been inverted, and a plane at the prepared size is not free.
  const yDen = plane('denoise Y shrunk / Cb out');
  const crOut = plane('denoise Cr out');
  const params = small('denoise params', 32);
  const lutD = small('denoise lut d', 4096);
  const lutX = small('denoise lut x', 4096);
  const lutParams = small('denoise lut params', 8);
  const blockSigma = small('denoise block sigma', blockCount);
  const planes = [y, cb, cr, yStab, yDen, crOut, params, lutD, lutX, lutParams, blockSigma];

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
  const statsLayout = layoutOf([[0, 'read'], [1, 'write'], [20, 'uniform']]);
  const selectLayout = layoutOf([[0, 'read'], [1, 'write'], [20, 'uniform']]);
  const alphaLayout = layoutOf([[0, 'write'], [20, 'uniform']]);
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
    stats: pipelineOf(GALOSH.blockStats, 'yuv_env_block_stats', statsLayout),
    select: pipelineOf(GALOSH.envSelect, 'yuv_env_select', selectLayout),
    alpha: pipelineOf(GALOSH.synthAlpha, 'yuv_synth_alpha', alphaLayout),
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

  // Thirteen slots: the two table kernels take no scalars at all.
  const SLOTS = 13;
  const uniform = device.createBuffer({
    label: 'denoise pushes',
    size: SLOTS * SLOT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  planes.push(uniform);

  const groups = {
    split: bind(splitLayout, [[0, frame], [1, y], [2, cb], [3, cr]], 0),
    statsLinear: bind(statsLayout, [[0, y], [1, blockSigma]], 1),
    selectLinear: bind(selectLayout, [[0, blockSigma], [1, params]], 11),
    alpha: bind(alphaLayout, [[0, params]], 2),
    gat: bind(gatLayout, [[0, y], [1, yStab], [2, params]], 3),
    statsGat: bind(statsLayout, [[0, yStab], [1, blockSigma]], 4),
    selectGat: bind(selectLayout, [[0, blockSigma], [1, params]], 12),
    norm: bind(scaleLayout, [[0, yStab], [1, params]], 5),
    lut: bind(lutLayout, [[0, params], [1, lutD], [2, lutX], [3, lutParams]], null),
    lutFin: bind(lutFinLayout, [[0, lutD], [1, lutParams]], null),
    shrink: bind(shrinkLayout, [[0, yStab], [1, yDen]], 6),
    denorm: bind(scaleLayout, [[0, yDen], [1, params]], 7),
    invert: bind(inverseLayout, [[0, yDen], [1, y], [2, lutD], [3, lutX], [4, lutParams]], 8),
    loess: bind(loessLayout, [[0, yStab], [1, cb], [2, cr], [3, yDen], [4, crOut]], 9),
    join: bind(joinLayout, [[0, y], [1, yDen], [2, crOut], [3, denoised]], 10),
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
  const flat = spread(npix);
  const pairs = spread(Math.ceil(npix / 2));
  const tiles: [number, number] = [over(width, PASS12_TILE), over(height, PASS12_TILE)];
  const full: [number, number] = [over(width, 16), over(height, 16)];

  return {
    planes,
    record(encoder, amounts) {
      // One write per run, which is sound because `writeBuffer` lands before the command
      // buffer recorded alongside it: no two passes here want different values in a slot.
      const scalars = new ArrayBuffer(SLOTS * SLOT);
      const ints = new Int32Array(scalars);
      const floats = new Float32Array(scalars);
      const at = (slot: number) => (slot * SLOT) / 4;
      ints[at(0)] = npix;
      ints.set([width, height, blocksWide, blocksHigh], at(1));
      ints[at(2)] = P_SIGMA_LINEAR;
      ints[at(3)] = npix;
      ints.set([width, height, blocksWide, blocksHigh], at(4));
      ints.set([npix, P_SIGMA_GAT], at(5));
      ints.set([blockCount, P_SIGMA_LINEAR], at(11));
      ints.set([blockCount, P_SIGMA_GAT], at(12));
      ints.set([width, height], at(6));
      floats[at(6) + 2] = amounts.luma;
      ints.set([npix, P_SIGMA_GAT], at(7));
      ints[at(8)] = npix;
      ints.set([width, height], at(9));
      floats[at(9) + 2] = LOESS_RIDGE;
      floats[at(9) + 3] = amounts.blend;
      ints[at(9) + 4] = LOESS_RADIUS;
      ints[at(10)] = npix;
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

      run(pipelines.split, groups.split, 0, flat);
      run(pipelines.stats, groups.statsLinear, 1, [over(blockCount, 64), 1]);
      run(pipelines.select, groups.selectLinear, 11, [1, 1]);
      run(pipelines.alpha, groups.alpha, 2, [1, 1]);
      run(pipelines.gat, groups.gat, 3, flat);
      run(pipelines.stats, groups.statsGat, 4, [over(blockCount, 64), 1]);
      run(pipelines.select, groups.selectGat, 12, [1, 1]);
      run(pipelines.norm, groups.norm, 5, flat);
      run(pipelines.lut, groups.lut, null, [16, 1]);
      run(pipelines.lutFin, groups.lutFin, null, [1, 1]);
      run(pipelines.shrink, groups.shrink, 6, tiles);
      run(pipelines.denorm, groups.denorm, 7, flat);
      run(pipelines.invert, groups.invert, 8, flat);
      run(pipelines.loess, groups.loess, 9, full);
      // Two pixels an invocation, which is what makes the pack race-free.
      run(pipelines.join, groups.join, 10, pairs);
      pass.end();
    },
  };
}
