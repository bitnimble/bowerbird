import { expect, test } from 'bun:test';
import { JobTargetSchema } from '../../../../schemas/jobs';
import type { RenditionTarget } from '../../workers/processing_types';
import { toTarget } from '../worker_command';

const rendition: RenditionTarget = {
  rendition: 'max',
  hdr: false,
  source: 'render',
  outputPath: '/tmp/print.png',
  size: 0,
  sdrQuantizer: 0,
  hdrQuantizer: 0,
  preset: 0,
  stillFullChroma: true,
  sdrFullChroma: true,
};

test('a print target names the print output and carries its profile as base64', () => {
  const command = toTarget({
    ...rendition,
    print: {
      space: 'device',
      bits: 16,
      intent: 'relativeColorimetric',
      blackPointCompensation: true,
      icc: new Uint8Array([0, 255, 16]),
      width: 1800,
      height: 1200,
      quarterTurns: 1,
    },
  });
  expect(command.output).toBe('print');
  expect(command.print).toEqual({
    space: 'device',
    bits: 16,
    intent: 'relativeColorimetric',
    blackPointCompensation: true,
    icc: 'AP8Q',
    width: 1800,
    height: 1200,
    quarterTurns: 1,
  });
  expect(JobTargetSchema.parse(command)).toEqual(command);
});

test('a rendition target keeps its range as the output and no print', () => {
  const command = toTarget({ ...rendition, hdr: true });
  expect(command.output).toBe('pq');
  expect(command.print).toBeUndefined();
  expect(toTarget(rendition).output).toBe('srgb');
});
