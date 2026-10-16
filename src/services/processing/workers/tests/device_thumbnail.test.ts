import { describe, expect, it, jest } from 'bun:test';
import type { Job, JobTarget } from '../../../../schemas/jobs';
import { describedFrom } from '../device_thumbnail';

const DESCRIPTOR = new Uint8Array([2, 2, 7]);

function target(describeOnly: boolean): JobTarget {
  return { rendition: 'grid', outputPath: '/data/grid/p.avif', describeOnly } as JobTarget;
}

function command(over: Partial<Job>): Job {
  return { rawFilePath: '/DCIM/p.jpg', targets: [target(true)], ...over } as Job;
}

describe('describedFrom', () => {
  it('opens nothing where the thumbnail was all the job was for', () => {
    const run = jest.fn(() => ({}));

    expect(describedFrom(DESCRIPTOR, command({}), run)).toEqual({ descriptor: DESCRIPTOR });
    expect(run).not.toHaveBeenCalled();
  });

  it("still reads the header, and keeps the thumbnail's descriptor over the job's", () => {
    const header = { width: 4080 } as NonNullable<ReturnType<typeof describedFrom>['header']>;
    const run = jest.fn((ran: Job) => ({ header, descriptor: new Uint8Array([9]), ran }));

    const outcome = describedFrom(DESCRIPTOR, command({ header: true }), run);

    expect(outcome.descriptor).toBe(DESCRIPTOR);
    expect(outcome.header).toBe(header);
    expect(run.mock.calls[0]?.[0].targets).toEqual([]);
  });

  it('keeps the targets that write a file', () => {
    const run = jest.fn((_: Job) => ({}));

    describedFrom(DESCRIPTOR, command({ targets: [target(true), target(false)] }), run);

    expect(run.mock.calls[0]?.[0].targets).toEqual([target(false)]);
  });
});
