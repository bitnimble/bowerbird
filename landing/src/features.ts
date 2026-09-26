import type { MDXContent } from 'mdx/types';

export type DemoId = 'hdr' | 'colour' | 'dust' | 'stacks' | 'triage' | 'merge' | 'panorama';

export type ShotFrame = 'desktop' | 'phone';

export const SHOT_SIZE: Record<ShotFrame, { width: number; height: number }> = {
  desktop: { width: 1600, height: 1000 },
  phone: { width: 780, height: 1688 },
};

/** `src` is a filename under `landing/public/shots/`, captured by `bun run shots` at its frame's size. */
export type Shot = { src: string; alt: string; frame: ShotFrame };

type FeatureCopy = {
  frontmatter: { title: string; summary: string } & ({ demo: DemoId } | { shot: Shot });
  default: MDXContent;
};

export type Feature = FeatureCopy['frontmatter'] & { id: string; Body: MDXContent };

const FEATURE_ORDER = ['hdr', 'stacks', 'triage', 'colour', 'editing', 'dust', 'merge', 'panorama', 'nas'];

const FEATURE_COPY = import.meta.glob<FeatureCopy>('./copy/features/*.mdx', { eager: true });

export const FEATURES: readonly Feature[] = FEATURE_ORDER.map((id) => {
  const copy = FEATURE_COPY[`./copy/features/${id}.mdx`];
  if (copy == null) throw new Error(`FEATURE_ORDER names ${id}, which has no copy/features/${id}.mdx`);
  return { ...copy.frontmatter, id, Body: copy.default };
});

if (FEATURES.length !== Object.keys(FEATURE_COPY).length) {
  throw new Error('A file in copy/features/ is missing from FEATURE_ORDER');
}

export function featureById(id: string): Feature {
  const feature = FEATURES.find((candidate) => candidate.id === id);
  if (feature == null) throw new Error(`No feature ${id}`);
  return feature;
}

export const REPO_URL = 'https://github.com/bitnimble/bowerbird';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const SITE = {
  name: 'Bowerbird',
  nav: { home: 'Home', features: 'Features', download: 'Download' },
  footer: 'Bowerbird is free and open source.',
  sourceCode: 'Source code',
};

export const DEMO = {
  hdr: {
    scenes: { gamut: 'Race cars', whites: 'Autumn', sun: 'Sunset', saturated: 'Seabird' },
    sceneLabel: 'Photo',
    viewLabel: 'View',
    sdr: 'SDR',
    split: 'Split',
    hdr: 'HDR',
    divider: 'Divider between the SDR and HDR renditions',
    sdrAlt: (scene: string) => `${scene}, as an ordinary JPEG`,
    hdrAlt: (scene: string) => `${scene}, in HDR`,
    note: 'Note: viewing HDR requires an HDR display, and Chrome or Safari.',
  },
  colour: {
    label: 'Colour profile',
    matched: 'Matched',
    neutral: 'None',
    matchedAlt: "A dog in autumn leaves, with the camera's colour matched",
    neutralAlt: 'The same photo with no colour profile',
  },
  dust: {
    before: 'Before',
    after: 'After',
    divider: 'Divider between the photo before and after dust removal',
    alt: 'A dusk sky with sensor dust spots across it',
  },
  stacks: {
    toggle: (count: number, open: boolean) => `${open ? 'Close' : 'Open'} the stack of ${count} photos`,
    alt: (name: string) => `Sample photo ${name}`,
  },
  triage: {
    pickA: 'Pick A',
    pickB: 'Pick B',
    round: (round: number, rounds: number) => `Round ${round} of ${rounds}`,
    pickSide: (side: string, name: string) => `Pick ${side}, ${name}`,
    winner: 'Best of the stack',
    pick: 'Pick',
    reject: 'Reject',
    restart: 'Start again',
  },
  merge: {
    person: (index: number) => `Remove the person in area ${index + 1}`,
    alt: 'A tree-lined street with 2 people walking across it',
    frameWith: 'The frame with both people',
    frameWithout: 'The frame with nobody crossing',
  },
  panorama: {
    alt: 'A wide photo of a lake below a mountain range at sunset',
    frame: (index: number) => `Frame ${index + 1} of the panorama`,
  },
};
