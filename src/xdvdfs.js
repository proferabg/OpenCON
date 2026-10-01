const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { textAscii, u32le } = await import(`./binary.js?v=${moduleVersion}`);

const SECTOR = 0x800;
const MAGIC = "MICROSOFT*XBOX*MEDIA";

export class XdvdfsVolume {
  constructor(source, packageHeader) {
    this.source = source;
    this.packageHeader = packageHeader;
    this.root = { name: "Root", path: "", directory: true, children: [] };
    this.entries = [];
  }

  static async open(source, packageHeader) {
    const volume = new XdvdfsVolume(source, packageHeader);
    await volume.initialize();
    return volume;
  }

  async initialize() {
    const descriptor = await this.source.read(0x10000, 0x30);
    if (textAscii(descriptor, 0, 20) !== MAGIC) throw new Error("The SVOD payload does not contain a valid XDVDFS volume descriptor.");
    this.sectorDelta = 0;
    const h = this.packageHeader.bytes;
    if (h.length > 921 && (h[913] & 0x40) === 0x40) this.sectorDelta = u32le(h, 917) * 2 - 34;
    const rootSector = correctedSector(u32le(descriptor, 20), this.sectorDelta);
    const rootSize = u32le(descriptor, 24);
    this.root.children = await this.readDirectory(rootSector, rootSize, "", new Set());
  }

  async readDirectory(sector, size, parentPath, directoryStack) {
    if (!size) return [];
    if (size > 64 * 1024 * 1024) throw new Error(`An XDVDFS directory table is implausibly large (${parentPath || "Root"}: sector ${sector}, size ${size}).`);
    const key = `${sector}:${size}`;
    if (directoryStack.has(key)) throw new Error("The XDVDFS directory tree contains a loop.");
    const nextStack = new Set(directoryStack).add(key);
    const table = await this.source.read(sector * SECTOR, size);
    const records = [];
    // Entries are physically sequential. The first two words form the on-disc
    // search tree, but walking those links alone misses sector padding and is
    // less tolerant of producer variations.
    for (let offset = 0; offset + 14 <= table.length;) {
      if (Math.floor((offset + 3) / SECTOR) !== Math.floor(offset / SECTOR)) {
        offset = Math.ceil(offset / SECTOR) * SECTOR;
        continue;
      }
      if (table[offset] === 0xFF && table[offset + 1] === 0xFF && table[offset + 2] === 0xFF && table[offset + 3] === 0xFF) {
        if (table.length - offset <= SECTOR) break;
        offset = Math.ceil((offset + 1) / SECTOR) * SECTOR;
        continue;
      }
      const nameLength = table[offset + 13];
      const recordLength = 14 + nameLength;
      if (!nameLength || offset + recordLength > table.length) break;
      records.push({
        name: textAscii(table, offset + 14, nameLength),
        sector: correctedSector(u32le(table, offset + 4), this.sectorDelta),
        size: u32le(table, offset + 8), attributes: table[offset + 12]
      });
      offset += (recordLength + 3) & ~3;
    }
    const nodes = [];
    for (const record of records) {
      const path = parentPath ? `${parentPath}/${record.name}` : record.name;
      const directory = !!(record.attributes & 0x10);
      const node = { ...record, path, directory, children: [] };
      if (directory) node.children = await this.readDirectory(record.sector, record.size, path, nextStack);
      else {
        node.stream = (chunkSize) => this.source.stream(record.sector * SECTOR, record.size, chunkSize);
        this.entries.push(node);
      }
      nodes.push(node);
    }
    return nodes;
  }
}

function correctedSector(sector, delta) {
  if (!delta) return sector;
  if (sector < delta) throw new Error("The SVOD sector correction would produce a negative sector.");
  return sector - delta;
}
