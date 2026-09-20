export const HdrPageStrings = {
  screenXdr: () => 'on a MacBook Pro XDR display',
  screenOled: () => 'on an OLED in a dark room',
  screenLcd: () => 'on an LCD in a lit room',

  rangeEyes: () => 'Your eyes',
  rangeSensor: () => 'Camera exposure',
  rangeHdr: () => 'A 12-bit HDR file',
  rangeJpeg: () => 'An 8-bit JPEG',

  stops: (count: number) => `${count} stops`,
  axisWhite: () => 'white',
  axisTick: (stops: number) => `${stops > 0 ? '+' : ''}${stops}`,

  sceneRapidsTitle: () => 'Whitewater under an overcast sky',
  sceneRapidsBody: () =>
    "An 8-bit file clips foam and clouds to white. Switch to HDR to see their detail.",
  sceneSunsetTitle: () => 'A sunset over railway tracks',
  sceneSunsetBody: () =>
    'An 8-bit file clips the brightest band above the horizon. HDR shows its light above white.',
  sceneArchesTitle: () => 'Lit arches at night',
  sceneArchesBody: () =>
    'In 8 bits, 48% of the bright pink pixels become white. HDR keeps them pink.',

  swapLabel: (label: string, showingHdr: boolean) =>
    `${label}. Showing the ${showingHdr ? 'HDR' : '8-bit'} version. Activate to see the other one.`,
  sdrAlt: (alt: string) => `${alt}, as 8 bits holds it`,
  hdrAlt: (alt: string) => `${alt}, in HDR`,
  eightBit: () => '8-bit',
  hdr: () => 'HDR',
  clickToSwitch: () => 'Select to switch',

  title: () => 'HDR photos',
  intro: () =>
    "Your camera's RAW files hold bright detail that an 8-bit JPEG clips. HDR shows it on screen.",
  introHowToUse: () => 'Every photo here starts as 8 bits. Select a photo to see its HDR version.',
  sdrNotice: () =>
    'Your display reports SDR, so these versions may look similar. Firefox may report SDR on HDR screens.',

  whiteHeading: () => "White isn't the top",
  whiteBody1: () =>
    "An 8-bit photo stores values from 0 to 255. Light can grow brighter than its white.",
  whiteBody2: () =>
    'Think of white paper in the scene as white. The sun, lamps, and reflections can be hundreds of times brighter.',
  whiteBody3: () =>
    'A JPEG leaves little room above paper white for bright highlights.',

  fitHeading: () => 'How much of a scene fits',
  fitBody: () =>
    'The chart shows stops above and below white. Hatched bars show what each format holds.',
  fitNote: () =>
    'Figures are approximate. File bars show stored light. Indented bars show what displays can show.',

  colourHeading: () => 'Bright colour in HDR',
  colourBody1: () =>
    'HDR keeps bright colours from fading towards white.',
  colourBody2: () =>
    "In 8-bit files, colour channels hit their limit and colours fade towards white. HDR keeps their colour as brightness rises.",
  colourBody3: () =>
    'Both swatches brighten the same 5 colours. The left fades at white. The right keeps its colour at 5× brightness.',
  swatchesAlt: () =>
    'The same 5 colours get brighter. Left colours fade at white. Right colours stay saturated.',

  examplesHeading: () => 'Example photos',

  aboutHeading: () => 'About these photos',
  aboutBody: () =>
    'Each pair comes from 1 RAW exported in HDR and 8 bits. Differences show where 8 bits clipped detail.',
};
