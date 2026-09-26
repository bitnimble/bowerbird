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

  swapLabel: (label: string, showingHdr: boolean) =>
    `${label}. Showing the ${showingHdr ? 'HDR' : '8-bit'} version. Activate to see the other one.`,
  sdrAlt: (alt: string) => `${alt}, as 8 bits holds it`,
  hdrAlt: (alt: string) => `${alt}, in HDR`,
  eightBit: () => '8-bit',
  hdr: () => 'HDR',
  clickToSwitch: () => 'Select to switch',

  title: () => 'Why HDR?',

  swatchesAlt: () =>
    'The same 5 colours get brighter. Left colours fade at white. Right colours stay saturated.',
};
