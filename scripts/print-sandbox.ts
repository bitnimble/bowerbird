// A CUPS server and two IPP Everywhere photo printers in Docker, for printshim's sandbox tests.
//
//   bun run scripts/print-sandbox.ts         start, or restart, the sandbox
//   bun run scripts/print-sandbox.ts stop
//   BOWERBIRD_PRINT_SANDBOX=1 bun run test:native --no-default-features printshim::sandbox
//
// The container shares the caller's network, so cupsd answers on localhost:6631 (the tests'
// default `CUPS_SERVER`). Its queues:
//
//   Sandbox_Photo  ippeveprinter on 8701 at an ipp:// URI, so printshim talks to the printer.
//   Sandbox_Relay  ippeveprinter on 8702 behind an http:// URI, so printshim goes through the queue.
//   Sandbox_Pdf    a PPD that takes only PDF, passed to an ippeveprinter on 8703 that takes no
//                  PWG raster, so printshim goes through the queue there too.
//
// What the printers received is served by cupsd under http://localhost:6631/received/.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pinnedRoot } from './pinned';

const IMAGE = 'bowerbird-print-sandbox';
const CONTAINER = 'bowerbird-print-sandbox';
const LOCAL = join(pinnedRoot(), 'print-sandbox');
const INSIDE = '/sandbox';
const RECEIVED = '/usr/share/cups/doc-root/received';
const DRIVER_PROFILE = join(LOCAL, 'driver.icc');
const READY_TIMEOUT_MS = 120_000;

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
    cups cups-ipp-utils icc-profiles-free avahi-daemon dbus \\
 && rm -rf /var/lib/apt/lists/*
`;

const margins = (top: number, right: number, bottom: number, left: number): string =>
  `MEMBER integer media-top-margin ${top} MEMBER integer media-right-margin ${right} ` +
  `MEMBER integer media-bottom-margin ${bottom} MEMBER integer media-left-margin ${left}`;

const media = (width: number, height: number, edges: string, type?: string): string =>
  `{ MEMBER collection media-size { MEMBER integer x-dimension ${width} ` +
  `MEMBER integer y-dimension ${height} } ${edges}` +
  (type == null ? '' : ` MEMBER keyword media-type ${type}`) +
  ' }';

const A4_BORDERED = margins(300, 300, 500, 300);
const BORDERLESS = margins(0, 0, 0, 0);

const PHOTO_ATTRIBUTES = `ATTR text printer-make-and-model "Bowerbird Sandbox Photo"
ATTR boolean color-supported true
ATTR mimeMediaType document-format-supported image/pwg-raster,application/octet-stream
ATTR mimeMediaType document-format-default application/octet-stream
ATTR keyword pwg-raster-document-type-supported adobe-rgb_8,adobe-rgb_16,srgb_8,srgb_16,rgb_8,rgb_16,sgray_8
ATTR resolution pwg-raster-document-resolution-supported 300dpi,600dpi
ATTR resolution printer-resolution-supported 300dpi,600dpi
ATTR resolution printer-resolution-default 300dpi
ATTR keyword pwg-raster-document-sheet-back normal
ATTR keyword media-supported iso_a4_210x297mm,na_index-4x6_4x6in
ATTR keyword media-default iso_a4_210x297mm
ATTR keyword media-ready iso_a4_210x297mm
ATTR keyword media-type-supported photographic-glossy,photographic-matte,stationery
ATTR keyword media-source-supported main
ATTR keyword media-col-supported media-size,media-type,media-top-margin,media-right-margin,media-bottom-margin,media-left-margin
ATTR integer media-top-margin-supported 0,300
ATTR integer media-right-margin-supported 0,300
ATTR integer media-bottom-margin-supported 0,500
ATTR integer media-left-margin-supported 0,300
ATTR collection media-col-database ${media(21000, 29700, A4_BORDERED)},${media(21000, 29700, BORDERLESS)},${media(10160, 15240, BORDERLESS)}
ATTR collection media-col-default ${media(21000, 29700, A4_BORDERED, 'photographic-glossy')}
ATTR collection media-col-ready ${media(21000, 29700, A4_BORDERED, 'photographic-glossy')}
ATTR rangeOfInteger copies-supported 1-99
ATTR integer copies-default 1
ATTR keyword print-color-mode-supported auto,color,monochrome
ATTR keyword print-color-mode-default color
ATTR enum print-quality-supported 3,4,5
ATTR enum print-quality-default 4
ATTR keyword print-scaling-supported auto,fill,fit,none
ATTR keyword print-scaling-default auto
ATTR keyword sides-supported one-sided
ATTR keyword sides-default one-sided
ATTR keyword job-creation-attributes-supported copies,media,media-col,print-color-mode,print-quality,print-scaling,printer-resolution,sides
ATTR collection printer-icc-profiles { MEMBER name profile-name "Glossy" MEMBER uri profile-url "http://127.0.0.1:6631/sandbox.icc" }
`;

const PDF_ATTRIBUTES = `ATTR text printer-make-and-model "Bowerbird Sandbox PDF"
ATTR boolean color-supported true
ATTR mimeMediaType document-format-supported application/pdf
ATTR mimeMediaType document-format-default application/pdf
ATTR keyword media-supported iso_a4_210x297mm,na_index-4x6_4x6in
ATTR keyword media-default iso_a4_210x297mm
`;

const PDF_PPD = `*PPD-Adobe: "4.3"
*FormatVersion: "4.3"
*FileVersion: "1.0"
*LanguageVersion: English
*LanguageEncoding: ISOLatin1
*PCFileName: "SANDBOX.PPD"
*Manufacturer: "Bowerbird"
*Product: "(Sandbox PDF)"
*ModelName: "Bowerbird Sandbox PDF"
*ShortNickName: "Bowerbird Sandbox PDF"
*NickName: "Bowerbird Sandbox PDF"
*PSVersion: "(3010.000) 0"
*LanguageLevel: "3"
*ColorDevice: True
*DefaultColorSpace: RGB
*FileSystem: False
*Throughput: "1"
*LandscapeOrientation: Plus90
*TTRasterizer: Type42
*cupsVersion: 2.4
*cupsFilter2: "application/pdf application/pdf 0 -"
*cupsICCProfile RGB.Glossy.300dpi/Glossy photo: "${DRIVER_PROFILE}"
*OpenUI *PageSize/Media Size: PickOne
*OrderDependency: 10 AnySetup *PageSize
*DefaultPageSize: A4
*PageSize A4/A4: "<</PageSize[595 842]>>setpagedevice"
*PageSize w288h432/4 x 6: "<</PageSize[288 432]>>setpagedevice"
*CloseUI: *PageSize
*OpenUI *PageRegion/Media Size: PickOne
*OrderDependency: 10 AnySetup *PageRegion
*DefaultPageRegion: A4
*PageRegion A4/A4: "<</PageSize[595 842]>>setpagedevice"
*PageRegion w288h432/4 x 6: "<</PageSize[288 432]>>setpagedevice"
*CloseUI: *PageRegion
*DefaultImageableArea: A4
*ImageableArea A4/A4: "8.5 8.5 586.5 833.5"
*ImageableArea w288h432/4 x 6: "0 0 288 432"
*DefaultPaperDimension: A4
*PaperDimension A4/A4: "595 842"
*PaperDimension w288h432/4 x 6: "288 432"
*OpenUI *MediaType/Media Type: PickOne
*OrderDependency: 10 AnySetup *MediaType
*DefaultMediaType: Plain
*MediaType Plain/Plain paper: ""
*MediaType Glossy/Glossy photo: ""
*CloseUI: *MediaType
`;

const CUPSD_CONF = `LogLevel warn
Listen 127.0.0.1:6631
ServerAlias *
Browsing Off
DefaultAuthType None
WebInterface Yes
<Location />
  Order allow,deny
  Allow all
</Location>
<Policy default>
  JobPrivateAccess all
  JobPrivateValues none
  SubscriptionPrivateAccess all
  SubscriptionPrivateValues none
  <Limit All>
    Order deny,allow
  </Limit>
</Policy>
`;

// Publishing off and loopback only: ippeveprinter will not start without a DNS-SD daemon, and on
// the caller's network this one must not announce test printers to the LAN.
const AVAHI_CONF = `[server]
allow-interfaces=lo
use-ipv6=no
[publish]
disable-publishing=yes
`;

// cupsd sizes its poll set by the open-file limit, and Docker's billion fails it with EFAULT.
const SETUP = `set -e
ulimit -n 4096
cp ${INSIDE}/avahi-daemon.conf /etc/avahi/avahi-daemon.conf
mkdir -p /run/dbus
dbus-daemon --system --fork
avahi-daemon -D --no-drop-root
cp ${INSIDE}/cupsd.conf /etc/cups/cupsd.conf
cp /usr/share/color/icc/sRGB.icc /usr/share/cups/doc-root/sandbox.icc
mkdir -p "${LOCAL}" ${RECEIVED}/photo ${RECEIVED}/relay ${RECEIVED}/pdf
cp /usr/share/color/icc/compatibleWithAdobeRGB1998.icc "${DRIVER_PROFILE}"
chmod -R 777 ${RECEIVED}
ippeveprinter -a ${INSIDE}/photo.conf -k -d ${RECEIVED}/photo -p 8701 "Sandbox Photo" > ${INSIDE}/photo.log 2>&1 &
ippeveprinter -a ${INSIDE}/photo.conf -k -d ${RECEIVED}/relay -p 8702 "Sandbox Relay" > ${INSIDE}/relay.log 2>&1 &
ippeveprinter -a ${INSIDE}/pdf.conf -k -d ${RECEIVED}/pdf -p 8703 "Sandbox PDF" > ${INSIDE}/pdf.log 2>&1 &
cupsd
for port in 8701 8702 8703 6631; do
  until (exec 3<>"/dev/tcp/127.0.0.1/$port") 2> /dev/null; do sleep 0.2; done
done
export CUPS_SERVER=127.0.0.1:6631
lpadmin -p Sandbox_Photo -E -v ipp://127.0.0.1:8701/ipp/print -m everywhere -D "Sandbox Photo" -L "Desk"
lpadmin -p Sandbox_Relay -E -v ipp://127.0.0.1:8702/ipp/print -m everywhere -D "Sandbox Relay"
lpadmin -p Sandbox_Relay -v http://127.0.0.1:8702/ipp/print
lpadmin -p Sandbox_Pdf -E -v ipp://127.0.0.1:8703/ipp/print -P ${INSIDE}/pdf.ppd -D "Sandbox PDF"
lpadmin -d Sandbox_Photo
touch ${INSIDE}/ready
exec sleep infinity
`;

function docker(args: string[], input?: string): string {
  const done = spawnSync('docker', args, { input, encoding: 'utf8' });
  if (done.status !== 0) {
    throw new Error(`docker ${args[0]}: ${done.error?.message ?? done.stderr.trim()}`);
  }
  return done.stdout;
}

/** The caller's own network namespace, which inside a container is that container's. */
function network(): string {
  if (!existsSync('/.dockerenv')) return 'host';
  const self = spawnSync('docker', ['inspect', hostname()], { stdio: 'ignore' });
  return self.status === 0 ? `container:${hostname()}` : 'host';
}

function stop(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

async function start(): Promise<void> {
  stop();
  rmSync(LOCAL, { recursive: true, force: true });
  const staged = join(LOCAL, 'staged');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'photo.conf'), PHOTO_ATTRIBUTES);
  writeFileSync(join(staged, 'pdf.conf'), PDF_ATTRIBUTES);
  writeFileSync(join(staged, 'pdf.ppd'), PDF_PPD);
  writeFileSync(join(staged, 'cupsd.conf'), CUPSD_CONF);
  writeFileSync(join(staged, 'avahi-daemon.conf'), AVAHI_CONF);
  writeFileSync(join(staged, 'setup.sh'), SETUP);

  docker(['build', '-q', '-t', IMAGE, '-'], DOCKERFILE);
  docker([
    'create',
    '--name',
    CONTAINER,
    '--network',
    network(),
    IMAGE,
    'bash',
    `${INSIDE}/setup.sh`,
  ]);
  docker(['cp', `${staged}/.`, `${CONTAINER}:${INSIDE}`]);
  docker(['start', CONTAINER]);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (spawnSync('docker', ['exec', CONTAINER, 'test', '-e', `${INSIDE}/ready`]).status !== 0) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]).trim();
    if (running !== 'true' || Date.now() > deadline) {
      const logs = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
      stop();
      throw new Error(`the print sandbox did not come up:\n${logs.stdout}${logs.stderr}`);
    }
    await Bun.sleep(250);
  }
  // The PPD's `*cupsICCProfile` names a file printshim reads from its own disk. cupsd checks it
  // on its own disk too, which is why the setup copies it to the same path in there.
  docker(['cp', `${CONTAINER}:${DRIVER_PROFILE}`, DRIVER_PROFILE]);
  process.stdout.write('print sandbox up: CUPS at localhost:6631\n');
}

if (process.argv[2] === 'stop') {
  stop();
} else {
  await start();
}
