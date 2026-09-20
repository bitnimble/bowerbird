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
  tagline: string;
  body: readonly string[];
  key: boolean;
  shot?: Shot;
  demo?: DemoId;
};

export const REPO_URL = 'https://github.com/bitnimble/bowerbird';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const FEATURES: readonly Feature[] = [
  {
    id: 'import',
    title: 'Import speed',
    tagline: 'Imports around 50 photos a second, even from an SD card',
    body: [
      "When Bowerbird imports a photo, the photo gets a thumbnail in the grid. It opens at full size in the photo viewer or the editor straight away.",
    ],
    key: true,
    shot: { src: 'grid.jpg', alt: 'The grid full of thumbnails from a new import', frame: 'desktop' },
  },
  {
    id: 'viewing',
    title: 'Viewing speed',
    tagline: 'Shows the next photo within 1 screen refresh',
    body: [
      'Most of the time you spend on photos goes on looking at them.',
      "Select the next photo, and it appears within 1 screen refresh. You don't wait for Bowerbird while you're viewing.",
    ],
    key: true,
    shot: { src: 'viewer.jpg', alt: 'The photo viewer showing 1 photo at full size, with the filmstrip below', frame: 'desktop' },
  },
  {
    id: 'hdr',
    title: 'HDR viewing',
    tagline: 'Shows the headroom in every RAW while you triage',
    body: [
      'Bowerbird makes an HDR rendition of every RAW as it imports, so you can view every photo in HDR straight away.',
      'HDR matters most during triage. It shows how much exposure headroom a RAW has before you edit it.',
      'HDR shows clipped highlights and clipped colour. A saturated light that a JPEG turns flat white keeps its colour in HDR. This helps most with night photos, especially in cities.',
    ],
    key: true,
    demo: 'hdr',
  },
  {
    id: 'editing',
    title: 'Light editing',
    tagline: 'Handles exposure, colour, noise, sharpening, and crop',
    body: [
      'Bowerbird is built for light edits to the whole photo, a couple of minutes each.',
      'The edit panel has Light, White balance, Colour, Effects, Detail, Dust removal, and Geometry, where you crop, straighten, and correct perspective.',
      'Noise reduction and sharpening are built in.',
    ],
    key: false,
    shot: { src: 'editor.jpg', alt: 'The editor, with a photo beside the edit panel', frame: 'desktop' },
  },
  {
    id: 'colour',
    title: 'Colour matching',
    tagline: "Matches your camera's own colours",
    body: [
      'Bowerbird builds a colour profile that matches how your camera rendered each photo.',
      "If you like your camera's colour, or switch its profiles between photos, you don't need to rebuild those looks in a RAW editor. Colour matching is on by default.",
    ],
    key: true,
    demo: 'colour',
  },
  {
    id: 'lens',
    title: 'Lens distortion matching',
    tagline: "Corrects each lens's distortion without a lens profile",
    body: [
      'Bowerbird works out the distortion correction for each of your lenses from your photos.',
      'If you have a profile for a lens, you can load it.',
    ],
    key: false,
  },
  {
    id: 'dust',
    title: 'Dust removal',
    tagline: 'Finds and removes spots from sensor dust',
    body: [
      'At a small aperture, dust on the sensor shows as spots in the photo. Bowerbird finds those spots and removes them.',
      "It compares many photos across the library to tell dust from detail, so it's accurate enough to be on by default.",
    ],
    key: false,
    demo: 'dust',
  },
  {
    id: 'stacks',
    title: 'Stacks',
    tagline: 'Groups similar photos into 1 thumbnail',
    body: [
      'Bowerbird groups similar photos into stacks, such as a burst or several photos of 1 scene.',
      'Bowerbird still groups the photos when exposure, focus, composition, or orientation changes between them.',
      'A stack shows as 1 thumbnail in the grid. Open it, and its photos appear in a row below.',
    ],
    key: true,
    demo: 'stacks',
  },
  {
    id: 'triage',
    title: 'Triage stack',
    tagline: 'Shows a stack 2 photos at a time until the best is left',
    body: [
      'Comparing 15 photos of 1 scene by flicking between them is slow. Triage stack shows the photos of a stack 2 at a time.',
      'Choose the better of the 2. It stays, the next photo takes the other side, and the stack narrows to its best photos.',
      'An optometrist tests your eyes the same way, asking whether lens A or lens B is sharper.',
    ],
    key: true,
    shot: { src: 'triage.jpg', alt: 'Triage stack, with photo A and photo B side by side', frame: 'desktop' },
    demo: 'triage',
  },
  {
    id: 'merge',
    title: 'Take best parts',
    tagline: 'Builds 1 photo from the best part of each frame',
    body: [
      "In a group photo that's almost right, someone has blinked. Bowerbird can take their face from a similar frame and merge it in.",
      "Take best parts also removes things you don't want in a photo, if you have a similar frame taken a moment later.",
    ],
    key: true,
    demo: 'merge',
  },
  {
    id: 'panorama',
    title: 'Panoramas',
    tagline: 'Merges overlapping RAWs into 1 wide photo',
    body: [
      'Bowerbird merges 20 RAWs into 1 panorama in seconds.',
      'The demo below is an illustration. It shows overlapping frames moving together into 1 photo.',
    ],
    key: false,
    demo: 'panorama',
  },
  {
    id: 'nas',
    title: 'NAS hosting',
    tagline: 'Keeps your files on your NAS while you edit in a web browser',
    body: [
      'Run Bowerbird on a NAS, and your photos stay on its storage.',
      'View, triage, and edit from your other devices in a web browser. Bowerbird is built to be used this way first.',
    ],
    key: true,
    shot: { src: 'settings.jpg', alt: 'The settings page, with a library on network storage', frame: 'desktop' },
  },
  {
    id: 'sync',
    title: 'Sync',
    tagline: 'Keeps a library the same on your laptop and your NAS',
    body: [
      'Run Bowerbird on a travel laptop too. Import and edit during the trip, then sync the library to your NAS when you get home.',
      'Bowerbird syncs a library when you ask it to. A library can sync with more than 2 devices.',
    ],
    key: false,
  },
  {
    id: 'devices',
    title: 'Supported devices',
    tagline: 'Runs on Mac, Linux, Windows, iPhone, and Android',
    body: [
      'View, triage, and edit on a Mac, Linux, Windows, an iPhone, or Android. Every feature works in any recent browser apart from Firefox.',
      'Viewing and triage need less. Any browser that can show a JPEG works, even on a TV.',
    ],
    key: false,
    shot: { src: 'mobile-grid.jpg', alt: 'The grid on a phone', frame: 'phone' },
  },
  {
    id: 'browser',
    title: 'Editing in a browser',
    tagline: 'Edits RAWs in a web browser, even on a phone',
    body: [
      "Bowerbird runs on your device's graphics hardware, which keeps it fast.",
      'On any fairly new device, every feature works in a web browser, including RAW editing on a phone. Editing large RAWs on a phone may not be reliable yet.',
    ],
    key: false,
    shot: { src: 'mobile-viewer.jpg', alt: 'A RAW photo open in the photo viewer on a phone', frame: 'phone' },
  },
  {
    id: 'organise',
    title: 'Shoots and albums',
    tagline: 'Organises photos into folders on disk and albums you choose',
    body: [
      'A shoot is a folder on disk. A photo belongs to 1 shoot.',
      'An album is a set of photos you choose, and a photo can be in as many albums as you like. Use shoots, albums, or both.',
    ],
    key: false,
    shot: { src: 'sidebar.jpg', alt: 'The sidebar with shoots and albums', frame: 'desktop' },
  },
  {
    id: 'read-only',
    title: 'Read-only libraries',
    tagline: 'Keeps files in read-only libraries unchanged on disk',
    body: [
      'Bowerbird never deletes your originals. At most, it moves them to the Bin.',
      "Make a library read-only, and Bowerbird can't move or delete anything in it. Around 95% of features still work.",
    ],
    key: false,
  },
];

export const SITE = {
  name: 'Bowerbird',
  nav: { home: 'Home', features: 'Features', download: 'Download' },
  footer: 'Bowerbird is free and open source.',
  sourceCode: 'Source code',
};

export const HOME = {
  pitch: 'A free, fast tool for triaging RAW photos, with light editing built in',
  lead: 'Bowerbird gets you through the thousands of photos from a holiday. It imports around 50 photos a second, shows the next photo within 1 screen refresh, and helps you find your Picks.',
  seeFeatures: 'See all features',
  heroShot: { src: 'grid.jpg', alt: 'The Bowerbird grid, full of thumbnails from 1 trip', frame: 'desktop' } satisfies Shot,
  keyHeading: 'Key features',
  more: 'Read more',
  tryHeading: 'HDR and SDR compared',
  tryBody: 'Each side shows the same RAW, as an ordinary JPEG and in HDR. Drag the divider to compare them.',
  whoHeading: "Who it's for",
  whoIntro: 'Bowerbird is for people who take many photos and keep a few. You may:',
  whoList: [
    'Come home from 1 shoot with 1,000 photos, or several thousand',
    'Keep 10 to 30% of them, which means looking at every one',
    'Edit most of your Picks lightly, in under 2 minutes each',
    'Edit a handful of favourites in depth',
  ],
  whoPeople:
    "That fits a holiday photographer, an event or wedding team, and a portrait, sports, or bird photographer. When you can't take your time, you take every photo you can and triage later.",
  whoNot:
    'If you take each photo slowly and deliberately, as on film, or you need everything a mature RAW editor has, Bowerbird may not suit you.',
  freeHeading: 'Always free',
  freeBody: "Bowerbird is free, and it always will be. It has no paid tier and no ads. Every feature is free, on every device.",
  stabilityBody:
    "Bowerbird is still early. It never deletes your originals, but an update may mean importing a library again, and edited photos may look slightly different afterwards.",
};

export const FEATURES_PAGE = {
  title: 'Features',
  lead: 'Bowerbird features with interactive sample photo demos',
  navLabel: 'Features on this page',
  comingSoonHeading: 'Coming soon',
  comingSoon: [
    'Local hosting with network backup',
    'AI noise reduction, sharpening, and object removal',
    'Print soft proofs in 3D lighting',
    'Custom colour mapping and editing',
    'Custom colour grading across photos',
    'Improved Fujifilm X-Trans support',
    'Scheduled Instagram posts',
    'Exposure and focus bracket merging',
    'Sony 4× and 16× pixel shift',
    'Live shared triage and editing',
  ],
  requirementsHeading: 'Requirements',
  requirements: [
    'Viewing needs a web browser, or the app.',
    'Editing needs a device with graphics hardware. The graphics built into most laptops and phones are enough.',
  ],
  stabilityHeading: 'Stability',
  stability: [
    'Bowerbird is still early.',
    'Bowerbird never deletes your originals. At most, it moves them to the Bin, and a read-only library stops even that.',
    "The catalogue records your albums, Picks, and edits, and it's still changing. An update may mean importing a library again. Edited photos may also look slightly different after an update.",
  ],
};

export const DEMO = {
  hdr: {
    scenes: { rapids: 'Rapids', sunset: 'Sunset', arches: 'Arches' },
    sceneLabel: 'Photo',
    viewLabel: 'View',
    sdr: 'SDR',
    split: 'Split',
    hdr: 'HDR',
    divider: 'Divider between the SDR and HDR renditions',
    sdrAlt: (scene: string) => `${scene}, as an ordinary JPEG`,
    hdrAlt: (scene: string) => `${scene}, in HDR`,
    note: 'The HDR side shows its full brightness only on an HDR screen, in Chrome or Safari. Anywhere else, it may look dimmer.',
  },
  colour: {
    label: 'Colour profile',
    matched: 'Matched',
    neutral: 'None',
    shots: {
      matched: { src: 'editor-matched.jpg', alt: "A photo in the editor, with the camera's colour matched", frame: 'desktop' },
      neutral: { src: 'editor-neutral.jpg', alt: 'The same photo, with no colour profile', frame: 'desktop' },
    } satisfies Record<string, Shot>,
  },
  dust: {
    before: 'Before',
    after: 'After',
    divider: 'Divider between the photo before and after dust removal',
    alt: 'A sunset over railway tracks',
    note: 'This is an illustration. The dust spots in the sky are drawn on.',
  },
  stacks: {
    hint: 'Select the stack to open it',
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
    hint: 'Select the better photo, or press the arrow keys',
  },
  merge: {
    hint: 'Select an outlined area to use that area from another frame',
    region: (index: number) => `Choose a frame for area ${index + 1}`,
    frames: 'Frames for this area',
    frame: (name: string) => `Use ${name}`,
    reset: 'Reset photo',
    alt: 'Rapids running through a gorge',
  },
  panorama: {
    stitch: 'Merge frames',
    apart: 'Separate frames',
    alt: '3 overlapping frames of a sunset over railway tracks',
  },
};
