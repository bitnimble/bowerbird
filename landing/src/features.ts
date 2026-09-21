export type DemoId = 'hdr' | 'colour' | 'dust' | 'stacks' | 'triage' | 'merge' | 'panorama';

export type ShotFrame = 'desktop' | 'phone';

export const SHOT_SIZE: Record<ShotFrame, { width: number; height: number }> = {
  desktop: { width: 1600, height: 1000 },
  phone: { width: 780, height: 1688 },
};

/** `src` is a filename under `landing/public/shots/`, captured by `bun run shots` at its frame's size. */
export type Shot = { src: string; alt: string; frame: ShotFrame };

export type Feature = {
  id: string;
  title: string;
  summary: string;
  body: readonly string[];
  visual: { demo: DemoId } | { shot: Shot };
};

export const REPO_URL = 'https://github.com/bitnimble/bowerbird';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const SPEED = {
  heading: 'Speed',
  body: [
    'Bowerbird shows the next photo within a single screen refresh. You never wait for it while you triage, even with thousands of photos to get through.',
    'It imports around 50 photos a second, even from an SD card or a hard drive, and every imported photo opens at full size straight away.',
  ],
};

export const HDR: Feature = {
  id: 'hdr',
  title: 'HDR viewing',
  summary: "Shows every RAW in HDR from the moment it's imported",
  body: [
    'See how much highlight detail a RAW is holding before you touch a slider. Every photo gets an HDR rendition as it imports, so the whole library is ready to triage.',
    'HDR also keeps colour a JPEG throws away. Bright paint, low sun, and city lights stay coloured instead of washing out to white.',
  ],
  visual: { demo: 'hdr' },
};

export const FEATURES: readonly Feature[] = [
  HDR,
  {
    id: 'stacks',
    title: 'Stacks',
    summary: 'Groups similar photos into a single thumbnail',
    body: [
      'Your grid shows each scene once, however many photos you took of it.',
      'Stacks hold together even when the exposure, focus, composition, or orientation changes between photos.',
    ],
    visual: { demo: 'stacks' },
  },
  {
    id: 'triage',
    title: 'Triage stack',
    summary: 'Finds the best photo in a stack, 2 at a time',
    body: [
      'Stop flicking back and forth between 15 burst shots. Triage stack puts two photos side-by-side, you choose the better one, and a few rounds later you have your best.',
      'It works the way an eye test does, with lens A against lens B.',
    ],
    visual: { demo: 'triage' },
  },
  {
    id: 'colour',
    title: 'Colour matching',
    summary: "Matches your camera's colour",
    body: [
      'Your RAWs are rendered looking like the photos you saw on your camera.',
      'Bowerbird fits a colour profile to every photo, down to the picture profile you had set, so you never rebuild a look by hand.',
    ],
    visual: { demo: 'colour' },
  },
  {
    id: 'editing',
    title: 'Light editing',
    summary: 'Finishes most photos in a couple of minutes',
    body: [
      'The editor has everything a quick edit needs: light, white balance, colour, noise reduction, sharpening, crop, straighten, and perspective.',
      'The picture keeps up with the slider as you drag it.',
    ],
    visual: { shot: { src: 'editor.jpg', alt: 'The editor, with a photo beside the edit panel', frame: 'desktop' } },
  },
  {
    id: 'dust',
    title: 'Dust removal',
    summary: 'Finds and removes sensor dust spots',
    body: [
      'Forget about the dust on your sensor. Bowerbird finds the dark spots it leaves at small apertures and removes them.',
      'It checks each spot against the rest of your library, so real detail is never mistaken for dust.',
    ],
    visual: { demo: 'dust' },
  },
  {
    id: 'merge',
    title: 'Take best parts',
    summary: 'Builds your best photo from several frames',
    body: [
      'Fix the group photo where someone blinked. Take their face from another frame, and Bowerbird merges it in.',
      "Remove a passer-by the same way, using a frame where they've moved on.",
    ],
    visual: { demo: 'merge' },
  },
  {
    id: 'panorama',
    title: 'Panoramas',
    summary: 'Merges a panorama in seconds',
    body: ['Bowerbird merges overlapping RAWs into one wide photo. Even 20 of them take a few seconds.'],
    visual: { demo: 'panorama' },
  },
  {
    id: 'nas',
    title: 'NAS hosting',
    summary: 'Runs on your NAS and works from any device',
    body: [
      'Keep your photos on your NAS and work from whichever device is to hand. Bowerbird runs next to your files, so there is nothing to copy to your computer first.',
      "Editing uses the graphics hardware of the device you're on, so a laptop, a phone, or a tablet is as quick as sitting at the NAS.",
    ],
    visual: { shot: { src: 'mobile-viewer.jpg', alt: 'A RAW photo open in the photo viewer on a phone', frame: 'phone' } },
  },
];

export const MORE_FEATURES: readonly { id: string; title: string; body: string }[] = [
  {
    id: 'lens',
    title: 'Lens distortion matching',
    body: "Bowerbird corrects each lens's distortion without a lens profile, by working it out from your own photos.",
  },
  {
    id: 'sync',
    title: 'Sync',
    body: 'Take Bowerbird with you on a laptop. Import and edit while you travel, then sync everything to your NAS when you get home.',
  },
  {
    id: 'read-only',
    title: 'Read-only libraries',
    body: 'Bowerbird never deletes your originals. Make a library read-only and it cannot move them either.',
  },
];

export const SITE = {
  name: 'Bowerbird',
  nav: { home: 'Home', features: 'Features', download: 'Download' },
  footer: 'Bowerbird is free and open source.',
  sourceCode: 'Source code',
};

export const HOME = {
  headline: 'A faster way through thousands of RAW photos',
  lead: 'Get through the thousands of photos you bring home from a trip. Bowerbird is free, it never makes you wait, and it has the editing to finish most of your Picks.',
  seeFeatures: 'See all features',
  heroShot: { src: 'viewer.jpg', alt: 'The photo viewer showing a photo at full size, with the filmstrip beside it', frame: 'desktop' } satisfies Shot,
  featuresHeading: 'More features',
  freeHeading: 'Always free',
  freeBody: "Bowerbird is free and open source, and that won't change. It has no paid tier and no ads, and every feature is free on every device.",
  stabilityBody:
    'Bowerbird is still early. It never deletes your originals, but an update may mean importing a library again, and edits may look a little different afterwards.',
};

export const FEATURES_PAGE = {
  title: 'Features',
  lead: 'Try most of them here on sample photos.',
  moreHeading: 'Also included',
  comingSoonHeading: 'Coming soon',
  comingSoon: [
    'Local hosting with network backup',
    'AI noise reduction, sharpening, and object removal',
    'Print soft proofs in 3D lighting',
    'Custom colour grading across photos',
    'Scheduled Instagram posts',
    'Exposure and focus bracket merging',
    'Sony 4× and 16× pixel shift',
    'Live shared triage and editing',
  ],
  requirementsHeading: 'Requirements',
  requirements: [
    'Viewing and triage need a web browser, or the app.',
    'Editing works in any recent browser apart from Firefox.',
    'Editing needs graphics hardware on the device you edit on. Integrated graphics is enough, which covers most laptops and phones.',
    'The NAS or server that runs Bowerbird needs graphics hardware as well.',
    'Bowerbird uses 2 to 4 GB of memory and 2 to 4 GB of graphics memory.',
  ],
  stabilityHeading: 'Stability',
  stability: [
    'Bowerbird is still early, and some parts are more settled than others.',
    'Your photos are safe. Bowerbird never deletes originals. The most it does is move them to the Bin, and a read-only library prevents that too.',
    'The catalogue, which holds your albums, Picks, and edits, is still changing. An update may mean importing a library again.',
    'Updates also change how edits are drawn, mostly to fix bugs, so an edited photo may look a little different afterwards.',
    "Editing a large RAW on a phone isn't reliable yet.",
  ],
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
