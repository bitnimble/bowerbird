import {
  PrinterCapabilitiesSchema,
  PrintersSchema,
  PrintJobIdSchema,
  PrintJobStateSchema,
  type Printer,
  type PrinterCapabilities,
  type PrintJobState,
  type PrintRequest,
  type PrintSheetRequest,
} from '../../../src/schemas/printing';
import { PathSegment, route } from '../../../src/schemas/route';
import { request, requestFile } from './request';

const printer = (id: string): string =>
  route(PathSegment.api(), PathSegment.printing(), PathSegment.printers(), encodeURIComponent(id));

export const printingApi = {
  printers: async (signal?: AbortSignal): Promise<Printer[]> =>
    (
      await request(
        PrintersSchema,
        'GET',
        route(PathSegment.api(), PathSegment.printing(), PathSegment.printers()),
        undefined,
        { signal },
      )
    ).printers,
  capabilities: (id: string, signal?: AbortSignal): Promise<PrinterCapabilities> =>
    request(
      PrinterCapabilitiesSchema,
      'GET',
      `${printer(id)}${route(PathSegment.capabilities())}`,
      undefined,
      { signal },
    ),
  profile: async (id: string, name: string): Promise<Uint8Array<ArrayBuffer>> => {
    const { bytes } = await requestFile(
      'GET',
      `${printer(id)}${route(PathSegment.profiles(), encodeURIComponent(name))}`,
    );
    return new Uint8Array(bytes);
  },
  submit: async (print: PrintRequest): Promise<number> =>
    (
      await request(
        PrintJobIdSchema,
        'POST',
        route(PathSegment.api(), PathSegment.printing(), PathSegment.jobs()),
        print,
      )
    ).jobId,
  job: (id: string, jobId: number): Promise<PrintJobState> =>
    request(
      PrintJobStateSchema,
      'GET',
      `${printer(id)}${route(PathSegment.jobs(), String(jobId))}`,
    ),
  sheet: async (sheet: PrintSheetRequest): Promise<Blob> => {
    const { bytes, mediaType } = await requestFile(
      'POST',
      route(PathSegment.api(), PathSegment.printing(), PathSegment.sheet()),
      sheet,
    );
    return new Blob([new Uint8Array(bytes)], { type: mediaType });
  },
};

export type PrintingSource = typeof printingApi;
