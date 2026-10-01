const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { equalBytes, textAscii, u16be, u16le, u24le, u32be } = await import(`./binary.js?v=${moduleVersion}`);

const END_BLOCK = 0xFFFFFF;
const LEVEL0 = 0xAA;
const LEVEL1 = 0x70E4;

export class StfsPackage {
  constructor(source, header) {
    this.source = source;
    this.header = header;
    this.hashPages = new Map();
    this.entries = [];
    this.root = { name: "Root", path: "", directory: true, children: [] };
  }

  static async open(source, header) {
    const packageFile = new StfsPackage(source, header);
    await packageFile.initialize();
    return packageFile;
  }

  async initialize() {
    const d = await this.source.read(0x379, 0x24);
    if (d[0] !== 0x24 || d[1] !== 0) throw new Error("Unsupported or damaged STFS volume descriptor.");
    const separation = d[2] & 3;
    this.directoryBlockCount = u16le(d, 3);
    this.directoryBlock = u24le(d, 5);
    this.blockCount = u32be(d, 0x1C);
    const roundedHeader = (this.header.headerSize + 0xFFF) & ~0xFFF;
    this.baseBlock = roundedHeader;
    if (roundedHeader === 0xB000 && separation === 1) this.shift = 0;
    else if (roundedHeader === 0xA000 && (separation === 0 || separation === 2)) this.shift = 1;
    else throw new Error("The STFS block layout is not recognized.");
    this.topIndex = (separation >>> 1) & 1;
    if (!this.directoryBlockCount) return;
    const directoryBlocks = await this.getChain(this.directoryBlock, this.directoryBlockCount);
    let logicalId = 0;
    for (const block of directoryBlocks) {
      const page = await this.source.read(this.dataOffset(block), 0x1000);
      for (let slot = 0; slot < 0x40; slot++) {
        const o = slot * 0x40;
        const flag = page[o + 0x28];
        const nameLength = flag & 0x3F;
        if (!nameLength || nameLength > 0x28) continue;
        const name = textAscii(page, o, nameLength);
        const size = u32be(page, o + 0x34);
        const entry = {
          id: logicalId++, name, directory: !!(flag & 0x80), consecutive: !!(flag & 0x40),
          startBlock: u24le(page, o + 0x2F), parentId: u16be(page, o + 0x32), size,
          blockCount: size ? Math.ceil(size / 0x1000) : 0, children: []
        };
        this.entries.push(entry);
      }
    }
    const folders = new Map(this.entries.filter(x => x.directory).map(x => [x.id, x]));
    for (const entry of this.entries) {
      const parent = entry.parentId === 0xFFFF ? this.root : folders.get(entry.parentId);
      (parent || this.root).children.push(entry);
    }
    const assign = (node, parentPath) => {
      node.path = parentPath ? `${parentPath}/${node.name}` : node.name;
      if (node.directory) for (const child of node.children) assign(child, node.path);
      else {
        node.stream = (chunkSize) => this.streamFile(node, chunkSize);
        node.verify = () => this.verifyFile(node);
      }
    };
    for (const child of this.root.children) assign(child, "");
  }

  generateDataBlock(block) {
    let value = (((Math.floor(block / LEVEL0) + 1) << this.shift) + block) >>> 0;
    if (block < LEVEL0) return value;
    value += ((Math.floor(block / LEVEL1) + 1) << this.shift);
    if (block < LEVEL1) return value >>> 0;
    return (value + (1 << this.shift)) >>> 0;
  }

  generateHashBlock(block, level) {
    const spaces = this.shift === 0 ? [0xAB, 0x718F] : [0xAC, 0x723A];
    if (level === 0) {
      let value = Math.floor(block / LEVEL0) * spaces[0];
      if (block < LEVEL0) return value;
      value += ((Math.floor(block / LEVEL1) + 1) << this.shift);
      if (block >= LEVEL1) value += 1 << this.shift;
      return value;
    }
    if (level === 1) return block < LEVEL1 ? spaces[0] : spaces[1] * Math.floor(block / LEVEL1) + (1 << this.shift);
    return spaces[1];
  }

  blockOffset(physicalBlock) { return physicalBlock * 0x1000 + this.baseBlock; }
  dataOffset(block) { return this.blockOffset(this.generateDataBlock(block)); }

  rawHashOffset(block, level) {
    let result = this.blockOffset(this.generateHashBlock(block, level));
    if (level === 0) result += 0x18 * (block % LEVEL0);
    else if (level === 1) result += 0x18 * (Math.floor(block / LEVEL0) % LEVEL0);
    else result += 0x18 * (Math.floor(block / LEVEL1) % LEVEL0);
    return result;
  }

  async recordLocation(block, wantedLevel) {
    let index = this.topIndex;
    if (this.blockCount > LEVEL1) {
      const location = this.rawHashOffset(block, 2) + (this.shift ? index * 0x1000 : 0);
      if (wantedLevel === 2) return location;
      index = (await this.readFlag(location)) >>> 30 & 1;
    } else if (wantedLevel === 2) return null;
    if (this.blockCount > LEVEL0) {
      const location = this.rawHashOffset(block, 1) + (this.shift ? index * 0x1000 : 0);
      if (wantedLevel === 1) return location;
      index = (await this.readFlag(location)) >>> 30 & 1;
    } else if (wantedLevel === 1) return null;
    return this.rawHashOffset(block, 0) + (this.shift ? index * 0x1000 : 0);
  }

  async readFlag(location) {
    const pageOffset = Math.floor(location / 0x1000) * 0x1000;
    let page = this.hashPages.get(pageOffset);
    if (!page) {
      page = await this.source.read(pageOffset, Math.min(0x1000, this.source.size - pageOffset));
      this.hashPages.set(pageOffset, page);
    }
    return u32be(page, location - pageOffset + 0x14);
  }

  async getRecord(block) {
    if (block >= this.blockCount) throw new Error(`STFS block 0x${block.toString(16)} is outside the package.`);
    const location = await this.recordLocation(block, 0);
    const flags = await this.readFlag(location);
    return { block, location, status: flags >>> 30, next: flags & END_BLOCK };
  }

  async getChain(startBlock, count) {
    if (!count) return [];
    const blocks = [];
    const seen = new Set();
    let block = startBlock;
    for (let i = 0; i < count; i++) {
      if (seen.has(block)) throw new Error("The STFS block chain contains a loop.");
      seen.add(block);
      blocks.push(block);
      if (i + 1 === count) break;
      const record = await this.getRecord(block);
      if (record.next === END_BLOCK) throw new Error("The STFS block chain ends before the recorded file size.");
      block = record.next;
    }
    return blocks;
  }

  async *streamFile(entry, preferredChunk = 1024 * 1024) {
    if (!entry.size) return;
    const blocks = await this.getChain(entry.startBlock, entry.blockCount);
    let remaining = entry.size;
    for (let i = 0; i < blocks.length && remaining > 0;) {
      const firstOffset = this.dataOffset(blocks[i]);
      let runBytes = 0x1000;
      let j = i + 1;
      while (j < blocks.length && runBytes < preferredChunk && this.dataOffset(blocks[j]) === firstOffset + runBytes) {
        runBytes += 0x1000;
        j++;
      }
      const count = Math.min(runBytes, remaining);
      yield await this.source.read(firstOffset, count);
      remaining -= count;
      i = j;
    }
  }

  async verifyFile(entry) {
    const blocks = await this.getChain(entry.startBlock, entry.blockCount);
    let good = 0;
    for (const block of blocks) {
      const data = await this.source.read(this.dataOffset(block), 0x1000);
      const location = await this.recordLocation(block, 0);
      const expected = await this.source.read(location, 20);
      const actual = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
      if (!equalBytes(expected, actual)) return { ok: false, checked: good + 1, total: blocks.length, block };
      good++;
    }
    return { ok: true, checked: good, total: blocks.length };
  }
}
