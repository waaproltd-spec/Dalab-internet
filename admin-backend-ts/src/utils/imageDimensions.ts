// Minimal, dependency-free width/height reader for the two formats the
// Agent App's image picker actually produces (JPEG, PNG) -- enough to
// enforce a fixed upload size (see promoAds.routes.ts) without pulling in
// an image-processing library (sharp needs native bindings, a real risk on
// the VPS's plain `npm install` deploy) just to read two numbers out of a
// header.
export function readImageDimensions(data: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk's 4-byte length + 4-byte
  // type ("IHDR"), then width (4 bytes BE) and height (4 bytes BE).
  if (
    data.length >= 24 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  // JPEG: starts with SOI (FF D8), then a series of FF-prefixed marker
  // segments. Each segment (other than a handful of standalone markers) is
  // [FF][marker][length:2 BE][payload...], where `length` counts itself
  // but not the FF/marker bytes. The SOFn marker's payload starts with
  // [precision:1][height:2 BE][width:2 BE] -- that's the actual image size.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = data.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}
