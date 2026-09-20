// What the stage's one device is opened with.
//
// A silent failure otherwise, and an expensive one: `paintExtended` reads the device's texture
// limit back to decide whether a frame can be uploaded as planes, and a device asked for nothing
// carries the spec's default of 8192 whatever the hardware offers. A native-resolution rendition
// off a 61MP body is 9504 on its long edge, so every one of them failed that check and fell to
// the fallback that tone maps an HDR picture down.
import { expect, test } from 'bun:test';
import { stageDevice } from '../stage_gpu';

test("the stage's device is opened at the adapter's texture limit, not the default", async () => {
  let asked: GPUDeviceDescriptor | undefined;
  const adapter = {
    limits: { maxTextureDimension2D: 16384 },
    requestDevice: (descriptor?: GPUDeviceDescriptor) => {
      asked = descriptor;
      const granted = descriptor?.requiredLimits?.maxTextureDimension2D ?? 8192;
      return Promise.resolve({ limits: { maxTextureDimension2D: granted } });
    },
  };
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: () => Promise.resolve(adapter) },
  });

  const device = await stageDevice();

  expect(asked?.requiredLimits?.maxTextureDimension2D).toBe(16384);
  expect(device?.limits.maxTextureDimension2D).toBe(16384);
});
