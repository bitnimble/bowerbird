import type { Job } from '../../../schemas/jobs';
import { ShellMediaListing } from '../../libraries/media_listing';
import { type JobOutcome, runJob } from '../rawshim/rawshim_job';
import { describeJpeg } from '../rawshim/rawshim_ops';
import type { RenditionJob } from './processing_types';

/** The stacking descriptor off the device's own thumbnail; null where it hands none over. */
export async function thumbnailDescriptor(job: RenditionJob): Promise<Uint8Array | null> {
  const thumbnail = job.deviceThumbnail;
  if (thumbnail == null || job.rendered != null) return null;
  const jpeg = await new ShellMediaListing(thumbnail.socket).thumbnail(
    thumbnail.imageId,
    job.rawFilePath,
  );
  return jpeg instanceof Uint8Array ? describeJpeg(jpeg) : null;
}

/** The rest of `command`, without the decode its describe-only targets were there for. */
export function describedFrom(
  descriptor: Uint8Array,
  command: Job,
  run: (command: Job) => JobOutcome = runJob,
): JobOutcome {
  const targets = command.targets.filter((target) => target.describeOnly !== true);
  const ran = targets.length === 0 && command.header !== true ? {} : run({ ...command, targets });
  return { ...ran, descriptor };
}
