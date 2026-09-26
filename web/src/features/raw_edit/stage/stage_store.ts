import { computed, observable } from 'mobx';
import type { JobLevels, NoiseFit } from '../../../../../src/schemas/jobs';
import type { EditDoc, ToneCurve } from '../../../../../src/schemas/photo_edits';
import type { EditStore } from '../edit/edit_store';
import type { Region } from '../edits';
import type { OpenStage } from '../local_decode/local_open';
import type { SoftProof } from '../proof/soft_proof';

export type EditStatus = 'idle' | 'opening' | 'live' | 'failed';

/** What an open is doing: the page's own steps, then the module's. */
export type OpenStep = 'preparing' | 'rendering' | OpenStage;

// Observables and computeds only. Every mutation is on RawEditPresenter.
export class StageStore {
  constructor(private readonly edit: EditStore) {}

  @observable accessor status: EditStatus = 'idle';
  @observable accessor step: OpenStep = 'preparing';
  /** Why the status is `failed`. */
  @observable accessor message = '';

  @observable accessor width = 0;
  @observable accessor height = 0;

  /**
   * The part of the frame on screen, in source pixels. Null until the frame is open.
   *
   * Where zoom and pan live: the draw runs at canvas resolution over this rectangle, so
   * moving it is the whole of navigating a photograph, and nothing else has to change.
   */
  @observable accessor region: Region | null = null;

  /**
   * The backing store the stage was last asked for, in device pixels.
   *
   * **Read off the element by nobody, because there is nothing to read.** The canvas belongs to
   * the worker once it has been handed over, so its width and height are the surface's
   * configuration over there rather than attributes on this side - and this is what the stage
   * reports in its diagnostics instead, for the spec that asks whether the picture is being drawn
   * at the viewport's size or the sensor's.
   */
  @observable accessor stage: { width: number; height: number } | null = null;

  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  @observable accessor matched = false;
  @observable accessor renderedMode: 'photo' | 'print' | null = null;

  /**
   * Whether this photograph has a sensor mosaic behind it, off the prepared header.
   *
   * True before anything is open, so the panel's shape does not flicker on the way in: what
   * closes the Detail and Dust groups is a photograph that turned out to be a finished picture,
   * not the absence of an answer yet.
   */
  @observable accessor mosaic = true;

  /**
   * Whether the picture was prepared on the server rather than in this tab.
   *
   * **What it closes is the loupe.** A loupe claims to be the export's own pixels, and what a
   * backend open holds is the picture at a level - so the glass would magnify something the export
   * is not. The Detail and Dust panels stay open: a move there asks the server for a new prepare.
   *
   * False before anything is open, so the panel's shape does not flicker on the way in.
   */
  @observable accessor preparedElsewhere = false;

  /**
   * The sensor's noise as the open measured it off the mosaic, for the loupe to hand back.
   *
   * Nothing here reads the numbers: the tick's own denoise works on the warped frame and has
   * `noise` for that. This is the tile renderer's, and it travels back rather than being
   * measured again because a tile is a crop of the photograph and a crop's own fit is not the
   * photograph's. Null for a frame decoded without an adapter, and for a sensor whose pattern the
   * denoise has no colour to separate - see [`denoises`].
   */
  @observable accessor noiseFit: NoiseFit | null = null;

  /**
   * The two Detail positions the open actually filtered at, 0 to 100.
   *
   * What the panel shows where the document has left a slider unset: the ramp from a noise fit to
   * a position is the module's, so the decode that used it reports the answer and this holds it.
   * Null until a frame is open.
   */
  @observable accessor detail: [number, number] | null = null;

  /** The camera match's curve. Null where nothing was matched or before a frame is open. */
  @observable accessor cameraCurve: ToneCurve | null = null;
  /** The camera match's exposure in stops, where one was fitted. */
  @observable accessor cameraExposure: number | null = null;
  /** The camera match's saturation on the slider's scale, where one was fitted. */
  @observable accessor cameraSaturation: number | null = null;

  @computed get headerKnown(): boolean {
    return this.detail != null;
  }

  /**
   * What each slider the photograph answers for shows where the document holds null
   * (`SliderSpec.measured`). Null until a frame is open.
   *
   * The camera's under either colour profile: None drops only the match's residual colour.
   */
  @computed get measured(): Partial<Record<keyof EditDoc, number>> | null {
    const detail = this.detail;
    if (detail == null) return null;
    return {
      luminanceNoise: detail[0],
      colourNoise: detail[1],
      exposure: this.cameraExposure ?? 0,
      saturation: this.cameraSaturation ?? 0,
    };
  }

  /**
   * Whether the Detail sliders can do anything to this photograph.
   *
   * **A measured fit is the whole of what the denoise needs, so its absence is the honest test.**
   * GALOSH separates colour from luma over one period of the pattern, so a sensor whose period does
   * not hold all three is declined outright and its frames come back with nothing measured; a decode
   * that found no adapter is the same state for a different reason, and the sliders are equally
   * inert in both. The panel reads this to say so rather than leaving a reader to drag a control
   * that cannot move the picture.
   *
   * Only once the open has finished: before that nothing has been measured yet, which is not the
   * same as nothing being measurable.
   */
  @computed get denoises(): boolean {
    return this.status !== 'live' || this.noiseFit != null;
  }

  /**
   * The longitudinal aberration the open's defringe took off, for the loupe to hand back.
   *
   * Travels for the same reason the fit above does: the pair is read over the whole frame, and a
   * tile fitting its own is defringed by whatever its window's edges say, differently from the
   * tiles beside it.
   */
  @observable accessor defocus: [number, number] | null = null;

  /**
   * The frame's diffuse white and scene peak as the open measured them, for the loupe to hand
   * back with a tile.
   *
   * Travels for the same reason the fit above does, and it is the more visible of the two: the
   * base is coded by dividing by white, so a crop measuring its own is a magnifier that lifts a
   * dark part of a photograph to reference white. The tick reads neither - the shader's copy of
   * these arrives in `edits` - so nothing here interprets them.
   */
  @observable accessor levels: JobLevels | null = null;

  /** The adapter behind the tick, for the readout: this is a GPU pipeline now. */
  @observable accessor adapter = '';

  @computed get live(): boolean {
    return this.status === 'live';
  }

  /**
   * Whether a control may act: there is a document to write into and a pipeline to draw it.
   *
   * Both halves, and `doc != null` is not a proxy for either. The document is read ahead of the
   * decode so the panel can show the reader their own settings while the frame is still coming -
   * so a control gated on it alone would be live over a picture that does not exist yet.
   */
  @computed get editable(): boolean {
    return this.live && this.edit.doc != null;
  }

  /**
   * Whether the photograph is being prepared again, which the mosaic groups turn beside their titles.
   *
   * **The only controls slow enough to need it.** Every other one is a uniform write and a tick;
   * the Detail pair and the dust three re-run the whole decode below the mosaic, which is seconds
   * on a large photograph. The bands arrive as they land, so the picture is never blank - what this
   * says is that the one on screen is not the answer yet.
   */
  @observable accessor repreparing = false;

  /**
   * What the stage is showing this photograph as: a rendition, or a print.
   *
   * A view of the edits rather than one of them, so it stays off the document and out of a save:
   * two readers of the same photograph may be proofing against different targets, and neither is
   * a thing the other should inherit.
   */
  @observable accessor softProof: SoftProof = 'hdr';
}
