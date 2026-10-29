const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { textAscii, u32le } = await import(`./binary.js?v=${moduleVersion}`);

const SECTOR = 0x800;
const MAGIC = "MICROSOFT*XBOX*MEDIA";
const DESCRIPTOR_OFFSET = 0x20 * SECTOR;

export const DISC_LAYOUTS = Object.freeze([
  Object.freeze({ name: "XISO", partitionOffset: 0x00000000 }),
  Object.freeze({ name: "XGD2", partitionOffset: 0x0FD90000 }),
  Object.freeze({ name: "XGD1", partitionOffset: 0x18300000 }),
  Object.freeze({ name: "XGD3", partitionOffset: 0x02080000 })
]);

export class XdvdfsVolume {
  constructor(source, packageHeader, format = "SVOD", partitionOffset = 0) {
    this.source = source;
    this.packageHeader = packageHeader;
    this.format = format;
    this.partitionOffset = partitionOffset;
    this.name = source.name;
    this.root = { name: "Root", path: "", directory: true, children: [] };
    this.entries = [];
  }

  static async open(source, packageHeader) {
    const volume = new XdvdfsVolume(source, packageHeader);
    await volume.initialize();
    return volume;
  }

  static async openDiscImage(source) {
    const layout = await detectDiscLayout(source);
    const volume = new XdvdfsVolume(source, null, layout.name, layout.partitionOffset);
    await volume.initialize();
    return volume;
  }

  async initialize() {
    const descriptor = await this.source.read(this.partitionOffset + DESCRIPTOR_OFFSET, 0x30);
    if (textAscii(descriptor, 0, 20) !== MAGIC) throw new Error("The payload does not contain a valid XDVDFS volume descriptor.");
    this.sectorDelta = 0;
    const h = this.packageHeader?.bytes;
    if (h?.length > 921 && (h[913] & 0x40) === 0x40) this.sectorDelta = u32le(h, 917) * 2 - 34;
    const rootSector = correctedSector(u32le(descriptor, 20), this.sectorDelta);
    const rootSize = u32le(descriptor, 24);
    this.assertExtent(rootSector * SECTOR, rootSize, "root directory");
    this.root.children = await this.readDirectory(rootSector, rootSize, "", new Set());
  }

  assertExtent(offset, size, description) {
    const absoluteOffset = this.partitionOffset + offset;
    if (!Number.isSafeInteger(absoluteOffset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || absoluteOffset + size > this.source.size) {
      throw new Error(`The XDVDFS ${description} is outside the image (${offset}+${size}).`);
    }
  }

  async readDirectory(sector, size, parentPath, directoryStack) {
    if (!size) return [];
    if (size > 64 * 1024 * 1024) throw new Error(`An XDVDFS directory table is implausibly large (${parentPath || "Root"}: sector ${sector}, size ${size}).`);
    const key = `${sector}:${size}`;
    if (directoryStack.has(key)) throw new Error("The XDVDFS directory tree contains a loop.");
    const nextStack = new Set(directoryStack).add(key);
    const tableOffset = sector * SECTOR;
    this.assertExtent(tableOffset, size, `directory ${parentPath || "Root"}`);
    const table = await this.source.read(this.partitionOffset + tableOffset, size);
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
        const fileOffset = record.sector * SECTOR;
        this.assertExtent(fileOffset, record.size, `file ${path}`);
        node.stream = (chunkSize) => this.source.stream(this.partitionOffset + fileOffset, record.size, chunkSize);
        this.entries.push(node);
      }
      nodes.push(node);
    }
    return nodes;
  }
}

export async function detectDiscLayout(source) {
  for (const layout of DISC_LAYOUTS) {
    const descriptorOffset = layout.partitionOffset + DESCRIPTOR_OFFSET;
    if (descriptorOffset + MAGIC.length > source.size) continue;
    const candidate = await source.read(descriptorOffset, MAGIC.length);
    if (textAscii(candidate, 0, MAGIC.length) === MAGIC) return layout;
  }
  throw new Error("No XISO, XGD1, XGD2, or XGD3 XDVDFS volume descriptor was found.");
}

function correctedSector(sector, delta) {
  if (!delta) return sector;
  if (sector < delta) throw new Error("The SVOD sector correction would produce a negative sector.");
  return sector - delta;
}
