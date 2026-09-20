import type { DemoId } from '../features';
import { ColourDemo } from './colour_demo';
import { DustDemo } from './dust_demo';
import { HdrDemo } from './hdr_demo';
import { MergeDemo } from './merge_demo';
import { PanoramaDemo } from './panorama_demo';
import { StacksDemo } from './stacks_demo';
import { TriageDemo } from './triage_demo';

export const DEMOS: Record<DemoId, () => JSX.Element> = {
  hdr: HdrDemo,
  colour: ColourDemo,
  dust: DustDemo,
  stacks: StacksDemo,
  triage: TriageDemo,
  merge: MergeDemo,
  panorama: PanoramaDemo,
};
