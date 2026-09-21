import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { photosApi } from '../../../api/photos';
import { envelopeOf } from '../../../api/request';
import { settingsApi } from '../../../api/settings';
import { dustSettings } from '../../../../../src/schemas/dust_settings';
import type { PrepareDevelop } from '../../../../../src/schemas/prepare_develop';
import { readPreparedHeader, type PreparedHeader } from '../../../../../src/schemas/prepared';
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
  longEdge: number,
  mosaic: LocalPrepare,
  onTheBackend: boolean,
): Promise<{
  header: PreparedHeader;
  /** What the loupe's tiles are built from. */
  local: LocalSource;
}> {
  const local = onTheBackend
    ? await preparedThere(photoId)
    : await preparedHere(photoId, longEdge, mosaic);
  const header = readPreparedHeader(local.prepared);
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
    // bytes to it on every open.
    if (!local.onTheBackend) keepPhotoAnalysis(photoId, measured);
  }
  return { header, local };
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
 * canvas they compose into - and for a phone, which cannot hold one photograph's samples let alone
 * a set of them.
 *
 * One level, the coarsest the picture has. So a reader sees the whole picture and can grade every
 * slider at tick speed; what they cannot yet do is zoom into its own pixels, there being no finer
 * level to ask for.
 */
async function preparedThere(photoId: string): Promise<LocalSource & { prepared: string }> {
  const { LocalDecoder } = await import('./local_decoder');
  const [settings, framed] = await Promise.all([settingsApi.get(), preparedPicture(photoId)]);
  // The grade the module is told about, which for this arm the prepare already used: the picture
  // arrived coded against these, and a tick anchors to the same numbers.
  const open: LocalOpen = {
    longEdge: 0,
    grade: {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    },
    defringe: settings.raw_defringe,
  };
  const decoder = new LocalDecoder();
  try {
    const prepared = await decoder.holdPicture(framed, open);
    return { decoder, open, onTheBackend: true, prepared };
  } catch (error) {
    // Closed on the way out, for `preparedHere`'s reason: nothing else can reach a decoder the
    // caller never received, so a reader retrying would leak a worker and a device per attempt.
    decoder.close();
    throw error;
  }
}

/**
 * This photograph's picture, framed as the library framed it, for what this client can show, at
 * `develop` where the reader has moved it from the last save.
 */
export async function preparedPicture(
  photoId: string,
  shown?: Shown,
  develop?: PrepareDevelop,
): Promise<Uint8Array<ArrayBuffer>> {
  const reply = await fetch(photosApi.preparedPictureUrl(photoId, shown, develop), {
    signal: shown?.signal ?? null,
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
 * Why a prepare was refused, as a line for the panel.
 *
 * The server's own message where it sent one - a composite whose frames this device does not
 * hold, a recipe it cannot read - because those are the reasons a reader can act on, and a status
 * code is not.
 */
async function refusal(reply: Response): Promise<string> {
  const text = await reply.text();
  return envelopeOf(text)?.error.message ?? `the picture could not be prepared: ${reply.status} ${text.slice(0, 400)}`;
}

async function preparedHere(
  photoId: string,
  longEdge: number,
  mosaic: LocalPrepare,
): Promise<LocalSource & { prepared: string }> {
  const { LocalDecoder } = await import('./local_decoder');
  const [settings, raw, photoAnalysis] = await Promise.all([
    settingsApi.get(),
    photosApi.downloadRaw(photoId),
    storedPhotoAnalysis(photoId),
  ]);
  const open: LocalOpen = {
    longEdge: Math.round(longEdge),
    photoAnalysis,
    grade: {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    },
    defringe: settings.raw_defringe,
  };
  // Kept rather than dropped once the frame is out: a tile is decoded from the same bytes, and
  // re-fetching 72MB per loupe position is the round trip this whole path exists to remove.
  const decoder = new LocalDecoder();
  try {
    await decoder.hold(raw);
    return {
      decoder,
      open,
      photoAnalysis,
      onTheBackend: false,
      prepared: await decoder.prepare(open, mosaic),
    };
  } catch (error) {
    // **Closed on the way out, or the thread outlives the open that failed** - and with it the
    // device, the mosaic and whatever the decode had already put on the GPU. Nothing else can
    // reach it: the caller only learns of a decoder through the value this never returned, so a
    // reader retrying an unreadable file would leak a worker and a device per attempt.
    decoder.close();
    throw error;
  }
}

/**
 * Everything a re-prepare is a function of, as this document sets it.
 *
 * Exported for the test that holds the defaults below against `EditDocSchema`'s, which is the only
 * place the two copies meet.
 */
export function prepareOf(doc: EditDoc | undefined): LocalPrepare {
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
  return {
    luminance: doc?.luminanceNoise ?? null,
    colour: doc?.colourNoise ?? null,
    denoiser: doc?.denoiser ?? 'galosh',
    // A fraction of the deconvolution where the document holds a slider position, which is the
    // unit the module reads it in and the same conversion `developed` makes for a rendition.
    sharpen: (doc?.sharpening ?? 50) / 100,
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
    at.sharpen === next.sharpen &&
    at.dust.enabled === next.dust.enabled &&
    // Only where the switch is on: with it off the pair cannot move a photosite, so re-preparing
    // for them would be seconds of work that cannot change the picture.
    (!next.dust.enabled ||
      (at.dust.sensitivity === next.dust.sensitivity &&
        at.dust.intensity === next.dust.intensity))
  );
}

/**
 * What some earlier open or render measured, where it has been kept.
 *
 * Most of a second of the open that depends on nothing but the file. A 404 is the ordinary answer
 * for a photograph nothing has measured yet, and then the open measures its own.
 */
async function storedPhotoAnalysis(photoId: string): Promise<number[] | undefined> {
  const reply = await fetch(photosApi.analysisUrl(photoId));
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
