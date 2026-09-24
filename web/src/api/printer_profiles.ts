import { PrinterProfilesSchema } from '../../../src/schemas/printer_profiles';
import { PathSegment, route } from '../../../src/schemas/route';
import { request, requestFile } from './request';

export const printerProfilesApi = {
  list: async (): Promise<string[]> =>
    (await request(PrinterProfilesSchema, 'GET', route(PathSegment.api(), PathSegment.printerProfiles()))).profiles,
  bytes: async (name: string): Promise<Uint8Array<ArrayBuffer>> => {
    const { bytes } = await requestFile('GET', route(PathSegment.api(), PathSegment.printerProfiles(), encodeURIComponent(name)));
    return new Uint8Array(bytes);
  },
};
