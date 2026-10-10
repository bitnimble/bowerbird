import { type Denoiser, type EditDoc } from '../../../../../src/schemas/photo_edits';
import { REQUEST_ACTIVITY_HEADER } from '../../../../../src/schemas/request_activity';
import { photosApi } from '../../../api/photos';
import { renditionsApi } from '../../../api/renditions';
import { envelopeOf } from '../../../api/request';
import { settingsApi } from '../../../api/settings';
import type { Settings, ViewerRendition } from '../../../../../src/schemas/settings';
import { dustSettings } from '../../../../../src/schemas/dust_settings';
import type { PrepareDevelop } from '../../../../../src/schemas/prepare_develop';
import { denoiserFor } from '../../../../../src/schemas/denoiser';
import { sharpeningOf } from '../../../../../src/schemas/sharpening';
import { readPreparedHeader, type PreparedHeader } from '../../../../../src/schemas/prepared';
import type { OpenStep } from '../stage/stage_store';
import type { LocalDecoder } from './local_decoder';
import type { LocalOpen, LocalPrepare } from './local_open';

/**
 * Opens the photograph in the worker, and answers with everything the panel shows about it.
 *
 * The frame itself stays there: what comes back is `edit::PreparedHeader` as JSON, which is the
 * levels, the match, the illuminant and the fits - and no pixels.
 *
 * **Two ways in and one pipeline.** A tab decodes the RAW itself where it can hold the picture;
 * where it cannot - a composite of several photographs, a canvas past the ceiling, a phone - the
 * server prepares it and the coded frame crosses instead. Both arms hand the module the same
 * thing, so the tick, the grade and the canvases below this are one implementation
 * (`prepare_choice.ts` decides, and nothing above here asks which it got).
 *
 * A browser that cannot run the module has no editor either way, deliberately: a fall-back that
 * produced a picture anyway is exactly how a tab that had quietly stopped decoding went unnoticed.
 */
export async function fetchPrepared(
  photoId: string,
  opening: Opening,
  mosaic: LocalPrepare,
  onStep: (step: OpenStep) => void,
  adoptStage: number | null,
): Promise<{
  header: PreparedHeader;
  /** What the loupe's tiles are built from. */
  local: LocalSource;
}> {
  const { LocalDecoder } = await import('./local_decoder');
  const decoder = new LocalDecoder();
  try {
    const local =
      opening.from === 'rendition'
        ? await renditionHere(decoder, photoId, opening.rendition, onStep, adoptStage)
        : opening.from === 'backend'
          ? await preparedThere(decoder, photoId, onStep, adoptStage)
          : await preparedHere(
              decoder,
              opening.original,
              opening.longEdge,
              mosaic,
              onStep,
              adoptStage,
            );
    return { header: await headerOf(photoId, opening, local), local };
  } catch (error) {
    // Under `adoptStage`, so the stage goes back: freed, the next photo waits on it forever.
    decoder.close(adoptStage);
    throw error;
  }
}

/** The open's header, with what it measured kept where the next open will find it. */
async function headerOf(
  photoId: string,
  opening: Opening,
  local: LocalSource & { prepared: string },
): Promise<PreparedHeader> {
  const header = readPreparedHeader(local.prepared);
  const fromRendition = opening.from === 'rendition';
  // What this open had to measure, where nothing had kept it: a tile cannot fit its own match, and
  // an unmatched tile is a magnifier showing a different picture from the stage it sits over.
  //
  // **The header is not the only channel, and cannot be.** It carries the analysis only where the
  // open *gained* something over what it was handed - and an open that detected particles was handed
  // them by its own detection a moment earlier, so on a photograph whose match and noise were
  // already on file it reports nothing new and the particles stay behind the worker boundary. Asking
  // the worker directly costs one message and closes that case.
  const measured = header.photoAnalysis ?? (await local.decoder.analysis()) ?? undefined;
  if (measured != null && measured.length > (local.photoAnalysis?.length ?? 0)) {
    local.photoAnalysis = measured;
    // Not on the backend arm: a prepare fills its analysis whatever it measured, because its
    // client holds nothing to fill it from - and the worker that measured it has already written
    // it beside the photograph. Sending it back would be this page returning the server's own
    // bytes to it on every open. Nor for a rendition, which is a picture of the RAW rather than it.
    if (!local.onTheBackend && !fromRendition) keepPhotoAnalysis(photoId, measured);
  }
  return header;
}

/** Which device prepares the picture, and from what. */
export type Opening =
  | { from: 'rendition'; rendition: ViewerRendition }
  | { from: 'backend' }
  | { from: 'here'; longEdge: number; original: Promise<Original> };

/** What a tab's own open reads, fetched before the document it is prepared at has arrived. */
export type Original = {
  settings: Settings;
  raw: Uint8Array<ArrayBuffer>;
  photoAnalysis: number[] | undefined;
};

/**
 * Abort through `signal` once nothing will read it: two downloads of one RAW at once fail one of
 * them in Chrome (`ERR_CACHE_WRITE_FAILURE`).
 */
export function downloadOriginal(photoId: string, signal: AbortSignal): Promise<Original> {
  const original = Promise.all([
    settingsApi.get(),
    photosApi.downloadRaw(photoId, signal),
    storedPhotoAnalysis(photoId),
  ]).then(([settings, raw, photoAnalysis]) => ({ settings, raw, photoAnalysis }));
  // An open closed before its document arrived never awaits this.
  original.catch(() => undefined);
  return original;
}

/** The worker holding this photograph's RAW, and the settings the open used, for the loupe's tiles. */
export type LocalSource = {
  decoder: LocalDecoder;
  /**
   * The open's request, and the worker's key for the photograph it is holding at the mosaic.
   *
   * **Never written to after the open.** The worker keys the held mosaic on this stringified, and
   * frees it the moment the string changes - so a field appended here between the open and the
   * first band throws away the levels that open measured, and every strip after it is coded
   * against a white of its own rows.
   */
  open: LocalOpen;
  /** What this photograph has measured, whether it was stored or this open worked it out. */
  photoAnalysis?: number[];
  /**
   * Whether the picture was prepared on the server rather than in this tab.
   *
   * What the page does differently: no loupe, since a loupe claims to be the export's own pixels
   * and what arrived is the picture at a level; and no re-prepare in bands, there being no mosaic
   * here for one to be cut from.
   */
  onTheBackend: boolean;
};

/**
 * The same open, from a picture the server prepared.
 *
 * **No RAW crosses.** That is the point for a composite - ten 61MP frames are 3.6GB before the
 * canvas they compose into - and for a device too small to hold one photograph's samples.
 */
async function preparedThere(
  decoder: LocalDecoder,
  photoId: string,
  onStep: (step: OpenStep) => void,
  adoptStage: number | null,
): Promise<LocalSource & { prepared: string }> {
  const settings = await settingsApi.get();
  const open: LocalOpen = {
    longEdge: 0,
    // The grade the module is told about, which for this arm the prepare already used: the picture
    // arrived coded against these, and a tick anchors to the same numbers.
    grade: gradeOf(settings),
    defringe: settings.raw_defringe,
  };
  const prepared = await decoder.holdPicture(
    await preparedPicture(photoId, undefined, undefined, onStep),
    open,
    adoptStage,
  );
  return { decoder, open, onTheBackend: true, prepared };
}

/**
 * The same open, from one of the photograph's renditions, decoded in this tab: what crosses the
 * network is the file rather than the samples it decodes to, and nothing is prepared on the server.
 */
async function renditionHere(
  decoder: LocalDecoder,
  photoId: string,
  rendition: ViewerRendition,
  onStep: (step: OpenStep) => void,
  adoptStage: number | null,
): Promise<LocalSource & { prepared: string }> {
  const [settings, file] = await Promise.all([
    settingsApi.get(),
    renditionFile(photoId, rendition, onStep),
  ]);
  const open: LocalOpen = {
    longEdge: 0,
    grade: gradeOf(settings),
    // Every edit is already in the file, so it is shown as it was encoded.
    defringe: 0,
    statedWhite: true,
  };
  return {
    decoder,
    open,
    onTheBackend: false,
    prepared: await decoder.holdRendition(file, open, adoptStage, onStep),
  };
}

/** A rendition's file, built where it is missing or behind the edits. */
async function renditionFile(
  photoId: string,
  rendition: ViewerRendition,
  onStep: (step: OpenStep) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  onStep('rendering');
  await renditionsApi.build(photoId, rendition);
  onStep('preparing');
  const reply = await fetch(renditionsApi.url(photoId, rendition), {
    headers: { [REQUEST_ACTIVITY_HEADER]: 'interactive' },
  });
  if (!reply.ok) throw new Error(await refusal(reply));
  return new Uint8Array(await reply.arrayBuffer());
}

/** This photograph's picture, framed as the library framed it, for what this client can show. */
export async function preparedPicture(
  photoId: string,
  shown?: Shown,
  develop?: PrepareDevelop,
  onStep?: (step: OpenStep) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  onStep?.('rendering');
  const reply = await fetch(photosApi.preparedPictureUrl(photoId, shown, develop), {
    signal: shown?.signal ?? null,
    headers: { [REQUEST_ACTIVITY_HEADER]: 'interactive' },
  });
  if (!reply.ok) throw new Error(await refusal(reply));
  return new Uint8Array(await reply.arrayBuffer());
}

/** What the reader can see, or the tiles they are short of, as the prepare's query states it. */
type Shown = { signal?: AbortSignal } & (
  | { region: { x: number; y: number; width: number; height: number }; stage: number }
  | {
      level: number;
      at: [number, number, number, number];
      parts: [number, number, number, number][];
    }
);

/**
 * Why a prepare was refused, as a line for the stage.
 *
 * The server's own message where it sent one - a composite whose frames this device does not
 * hold, a recipe it cannot read - because those are the reasons a reader can act on, and a status
 * code is not.
 */
async function refusal(reply: Response): Promise<string> {
  const text = await reply.text();
  return (
    envelopeOf(text)?.error.message ??
    `the picture could not be prepared: ${reply.status} ${text.slice(0, 400)}`
  );
}

async function preparedHere(
  decoder: LocalDecoder,
  original: Promise<Original>,
  longEdge: number,
  mosaic: LocalPrepare,
  onStep: (step: OpenStep) => void,
  adoptStage: number | null,
): Promise<LocalSource & { prepared: string }> {
  const { settings, raw, photoAnalysis } = await original;
  const open: LocalOpen = {
    longEdge: Math.round(longEdge),
    photoAnalysis,
    grade: gradeOf(settings),
    defringe: settings.raw_defringe,
  };
  await decoder.hold(raw);
  return {
    decoder,
    open,
    photoAnalysis,
    onTheBackend: false,
    prepared: await decoder.prepare(open, mosaic, adoptStage, onStep),
  };
}

function gradeOf(settings: Settings): LocalOpen['grade'] {
  return {
    referenceWhiteNits: settings.hdr_reference_white_nits,
    whiteQuantile: settings.hdr_white_quantile,
  };
}

/**
 * Everything a re-prepare is a function of, as this document sets it.
 *
 * Exported for the test that holds the defaults below against `EditDocSchema`'s, which is the only
 * place the two copies meet.
 */
export function prepareOf(
  doc: EditDoc | undefined,
  libraryDenoiser: Denoiser,
  upscalable: boolean,
): LocalPrepare {
  // `EditDocSchema`'s own defaults where there is no document, not zero: the store is filled with a
  // neutral document either way, so answering 0 here would open the photograph at a Detail nothing
  // asked for and re-prepare it the moment the first control settles.
  //
  // Null on both halves of Detail, which is that default: the module answers an unset slider with
  // this frame's own fit, and a number here would be the page overriding a measurement it cannot
  // make (`galosh::Detail`).
  //
  // Spelled rather than read off the schema, as `dustSettings` spells its pair: that module imports
  // zod, and the page keeps zod out of its bundle (`photo_edits.ts` says so, and every other import
  // of it on this side is a type).
  const denoiser = denoiserFor(doc?.denoiser ?? libraryDenoiser, upscalable);
  return {
    luminance: doc?.luminanceNoise ?? null,
    colour: doc?.colourNoise ?? null,
    denoiser,
    highlightRecovery: doc?.highlightRecovery ?? 100,
    // A fraction of the deconvolution where the document holds a slider position, which is the
    // unit the module reads it in and the same conversion `developed` makes for a rendition.
    sharpen: sharpeningOf(doc?.sharpening ?? null, denoiser) / 100,
    dust: dustSettings(doc),
    repairs: doc?.repairs ?? [],
  };
}

/**
 * Whether two Detail settings would produce the same frame.
 *
 * Field by field rather than a deep compare, because a `LocalPrepare` crosses to a worker and has to
 * stay a plain value - but written once, so a field added to the type is a field this forgets in one
 * place rather than three.
 */
export function samePrepare(at: LocalPrepare | null, next: LocalPrepare): boolean {
  return (
    sameDevelop(at, next) &&
    // As text: both are the document's own plain values, and the page keeps the schema's
    // structural compare - and zod with it - out of its bundle.
    JSON.stringify(at?.repairs) === JSON.stringify(next.repairs)
  );
}

/** A prepare's settings as the document spells them, which is what the server is told. */
export function developOf(prepare: LocalPrepare): PrepareDevelop {
  return {
    luminanceNoise: prepare.luminance,
    colourNoise: prepare.colour,
    denoiser: prepare.denoiser,
    highlightRecovery: prepare.highlightRecovery,
    sharpening: Math.round(prepare.sharpen * 100),
    dustRemoval: prepare.dust.enabled,
    dustSensitivity: Math.round(prepare.dust.sensitivity * 100),
    dustIntensity: Math.round(prepare.dust.intensity * 100),
  };
}

/** `samePrepare` short of the repairs: the settings that run before the frame is coded. */
export function sameDevelop(at: LocalPrepare | null, next: LocalPrepare): boolean {
  return (
    at != null &&
    at.luminance === next.luminance &&
    at.colour === next.colour &&
    at.denoiser === next.denoiser &&
    at.highlightRecovery === next.highlightRecovery &&
    at.sharpen === next.sharpen &&
    at.dust.enabled === next.dust.enabled &&
    // Only where the switch is on: with it off the pair cannot move a photosite, so re-preparing
    // for them would be seconds of work that cannot change the picture.
    (!next.dust.enabled ||
      (at.dust.sensitivity === next.dust.sensitivity && at.dust.intensity === next.dust.intensity))
  );
}

/**
 * What some earlier open or render measured, where it has been kept.
 *
 * Most of a second of the open that depends on nothing but the file. A 404 is the ordinary answer
 * for a photograph nothing has measured yet, and then the open measures its own.
 */
async function storedPhotoAnalysis(photoId: string): Promise<number[] | undefined> {
  const reply = await fetch(photosApi.analysisUrl(photoId), {
    headers: { [REQUEST_ACTIVITY_HEADER]: 'interactive' },
  });
  if (!reply.ok) return undefined;
  return Array.from(new Uint8Array(await reply.arrayBuffer()));
}

/**
 * Hands back what this open had to measure, so the next one does not spend the second again.
 *
 * Not awaited, and a failure is not raised: the picture is already on screen by then, and a
 * photograph that measures again next time is slower rather than wrong. The blob carries whatever
 * the open was handed as well as what it worked out, so this cannot drop the rendition worker's
 * half of the file except by losing a race with it.
 */
export function keepPhotoAnalysis(photoId: string, analysis: number[]): void {
  void fetch(photosApi.analysisUrl(photoId), {
    method: 'PUT',
    body: new Uint8Array(analysis),
  }).catch(() => undefined);
}
