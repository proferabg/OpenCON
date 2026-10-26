const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { SliceSource } = await import(`./source.js?v=${moduleVersion}`);

export const MONOLITH_HEADER_SIZE = 0xB000;
export const FRAGMENT_SIZE = 0x0A290000;
const FRAGMENT_PREFIX = 0x2000;
const DATA_RUN = 0xCC000;
const PHYSICAL_RUN = 0xCD000;

export function fragmentsFromMonolith(source) {
  const fragments = [];
  let offset = MONOLITH_HEADER_SIZE;
  let index = 0;
  while (offset < source.size) {
    const size = Math.min(FRAGMENT_SIZE, source.size - offset);
    fragments.push(new SliceSource(source, offset, size, `Data${String(index).padStart(4, "0")}`));
    offset += size;
    index++;
  }
  return fragments;
}

export function splitMonolith(source) {
  if (source.size <= MONOLITH_HEADER_SIZE) throw new Error("The PIRS file does not contain monolithic SVOD data.");
  return {
    header: new SliceSource(source, 0, MONOLITH_HEADER_SIZE, source.name),
    fragments: fragmentsFromMonolith(source)
  };
}

export class SvodIsoSource {
  constructor(fragments, prefixSize) {
    this.fragments = fragments;
    this.prefixSize = prefixSize;
    this.fragmentDataSizes = fragments.map(fragmentDataSize);
    this.size = prefixSize + this.fragmentDataSizes.reduce((a, b) => a + b, 0);
    this.name = "SVOD virtual disc";
  }

  static async open(fragments) {
    if (!fragments.length) throw new Error("No Data0000/Data0001 SVOD fragments were selected.");
    fragments.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (fragments[0].size < FRAGMENT_PREFIX + 3) throw new Error("Data0000 is too small to contain an SVOD volume.");
    const marker = await fragments[0].read(FRAGMENT_PREFIX, 3);
    const hasXsf = marker[0] === 0x58 && marker[1] === 0x53 && marker[2] === 0x46;
    return new SvodIsoSource(fragments, hasXsf ? 0 : 0x10000);
  }

  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new RangeError("Read outside virtual SVOD disc.");
    const output = new Uint8Array(length);
    let destination = 0;
    let position = offset;
    if (position < this.prefixSize) {
      const zeroBytes = Math.min(length, this.prefixSize - position);
      destination += zeroBytes;
      position += zeroBytes;
    }
    let logical = position - this.prefixSize;
    for (let i = 0; i < this.fragments.length && destination < length; i++) {
      const fragmentLength = this.fragmentDataSizes[i];
      if (logical >= fragmentLength) { logical -= fragmentLength; continue; }
      const count = Math.min(length - destination, fragmentLength - logical);
      await this.readFragment(i, logical, count, output, destination);
      destination += count;
      logical = 0;
    }
    return output;
  }

  async readFragment(index, logicalOffset, length, output, destination) {
    const fragment = this.fragments[index];
    let remaining = length;
    let logical = logicalOffset;
    while (remaining > 0) {
      const cycle = Math.floor(logical / DATA_RUN);
      const within = logical % DATA_RUN;
      const count = Math.min(remaining, DATA_RUN - within);
      const physical = FRAGMENT_PREFIX + cycle * PHYSICAL_RUN + within;
      const bytes = await fragment.read(physical, count);
      output.set(bytes, destination);
      destination += count;
      logical += count;
      remaining -= count;
    }
  }

  async *stream(offset, length, chunkSize = 1024 * 1024) {
    let position = offset;
    const end = offset + length;
    while (position < end) {
      const count = Math.min(chunkSize, end - position);
      yield await this.read(position, count);
      position += count;
    }
  }
}

function fragmentDataSize(fragment) {
  const remaining = Math.max(0, fragment.size - FRAGMENT_PREFIX);
  const complete = Math.floor(remaining / PHYSICAL_RUN);
  const tail = remaining % PHYSICAL_RUN;
  return complete * DATA_RUN + Math.min(tail, DATA_RUN);
}
