const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const [binary, headerModule, sourceModule, stfsModule, svodModule, xdvdfsModule, xexModule, xzpModule] = await Promise.all([
  import(`./binary.js?v=${moduleVersion}`),
  import(`./header.js?v=${moduleVersion}`),
  import(`./source.js?v=${moduleVersion}`),
  import(`./stfs.js?v=${moduleVersion}`),
  import(`./svod.js?v=${moduleVersion}`),
  import(`./xdvdfs.js?v=${moduleVersion}`),
  import(`./xex.js?v=${moduleVersion}`),
  import(`./xzp.js?v=${moduleVersion}`)
]);
const { formatBytes, hex, safeName } = binary;
const { readPackageHeader, versionText } = headerModule;
const { BlobSource, collectStream } = sourceModule;
const { StfsPackage } = stfsModule;
const { fragmentsFromMonolith, SvodIsoSource } = svodModule;
const { XdvdfsVolume } = xdvdfsModule;
const { MAX_XEX_HEADER_SIZE, formatXexTimestamp, formatXexVersion, parseXex } = xexModule;
const { XzpArchive } = xzpModule;

const MAX_IMAGE_PREVIEW_SIZE = 64 * 1024 * 1024;
const MAX_TEXT_PREVIEW_SIZE = 8 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["png", "image/png"], ["apng", "image/apng"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["jfif", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["bmp", "image/bmp"],
  ["avif", "image/avif"], ["ico", "image/x-icon"], ["cur", "image/x-icon"], ["svg", "image/svg+xml"]
]);

const $ = (id) => document.getElementById(id);
const state = { package: null, header: null, rows: [], selected: null, collapsed: new Set() };
let openGeneration = 0;
let selectionGeneration = 0;
let dragDepth = 0;

$("openFiles").addEventListener("click", () => $("fileInput").click());
$("openFolder").addEventListener("click", () => $("folderInput").click());
$("fileInput").addEventListener("change", (event) => { openFiles([...event.target.files]); event.target.value = ""; });
$("folderInput").addEventListener("change", (event) => { openFiles([...event.target.files]); event.target.value = ""; });
$("filter").addEventListener("input", renderRows);
$("extractButton").addEventListener("click", extractSelected);
$("extractAllButton").addEventListener("click", extractAll);
$("verifyButton").addEventListener("click", verifySelected);
$("previewDialog").addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  if (!inside) dialog.close();
});

document.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
  $("dropZone").classList.add("drag");
});
document.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) clearDragState();
});
document.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  clearDragState();
  openFiles([...event.dataTransfer.files]);
});

function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function clearDragState() {
  document.body.classList.remove("dragging");
  $("dropZone").classList.remove("drag");
}

async function openFiles(files) {
  if (!files.length) return;
  const generation = ++openGeneration;
  setStatus("Inspecting package…");
  try {
    const headerFile = await findHeaderFile(files);
    if (!headerFile) {
      const xzpFile = await findXzpFile(files);
      if (!xzpFile) throw new Error("No CON, LIVE, PIRS, or XZP package header was found. For split GoD content, select the header and its .data folder together.");
      const source = new BlobSource(xzpFile, xzpFile.name);
      const archive = await XzpArchive.open(source, xzpFile.name);
      if (generation !== openGeneration) return;
      state.package = archive;
      state.header = null;
      state.family = `XZP v${archive.version} resource archive`;
      state.selected = null;
      selectionGeneration++;
      closePreview();
      state.collapsed.clear();
      state.rows = flatten(archive.root);
      renderXzpPackage(archive, xzpFile);
      renderRows();
      $("dropZone").classList.add("hidden");
      $("workspace").classList.remove("hidden");
      $("extractAllButton").disabled = !state.rows.some(row => !row.node.directory);
      setStatus(`Opened ${xzpFile.name}`);
      return;
    }
    const source = new BlobSource(headerFile, headerFile.name);
    const header = await readPackageHeader(source);
    let packageReader;
    let family;
    if (!header.installed) {
      packageReader = await StfsPackage.open(source, header);
      family = "STFS file-table package";
    } else {
      let fragments = findDataFragments(files).map(file => new BlobSource(file, file.name));
      if (!fragments.length && source.size > 0xB000) fragments = fragmentsFromMonolith(source);
      if (!fragments.length) throw new Error("This is an installed-game/SVOD header. Select it together with Data0000 (or select the entire .data folder).");
      const virtualDisc = await SvodIsoSource.open(fragments);
      packageReader = await XdvdfsVolume.open(virtualDisc, header);
      family = source.size > 0xB000 ? "Monolithic Xbox App / XUP (SVOD)" : "Split GoD / SVOD package";
    }
    if (generation !== openGeneration) return;
    state.package = packageReader;
    state.header = header;
    state.family = family;
    state.selected = null;
    selectionGeneration++;
    closePreview();
    state.collapsed.clear();
    state.rows = flatten(packageReader.root);
    renderPackage(header, headerFile, family);
    renderRows();
    $("dropZone").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    $("extractAllButton").disabled = !state.rows.some(row => !row.node.directory);
    setStatus(`Opened ${headerFile.name}`);
  } catch (error) {
    if (generation !== openGeneration) return;
    showError(error);
    setStatus("Open failed");
  }
}

async function findXzpFile(files) {
  return files.find(file => file.name.toLowerCase().endsWith(".xzp")) || null;
}

async function findHeaderFile(files) {
  const candidates = files.filter(file => !/^Data\d{4}$/i.test(file.name));
  for (const file of candidates) {
    if (file.size < 4) continue;
    const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const magic = String.fromCharCode(...bytes);
    if (["CON ", "LIVE", "PIRS"].includes(magic)) return file;
  }
  return null;
}

function findDataFragments(files) {
  return files.filter(file => /^Data\d{4}$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function flatten(root) {
  const rows = [];
  const visit = (node, depth, ancestors) => {
    if (node !== root) rows.push({ node, depth, ancestors });
    if (node.directory) {
      const childAncestors = node === root ? ancestors : [...ancestors, node.path];
      for (const child of node.children || []) visit(child, depth + (node === root ? 0 : 1), childAncestors);
    }
  };
  visit(root, 0, []);
  return rows;
}

function renderPackage(header, file, family) {
  $("packageTitle").textContent = header.displayTitle || header.packageTitle || file.name;
  $("packageSubtitle").textContent = `${family} · ${formatBytes(file.size)}`;
  const fields = [
    ["Signature", header.signatureType], ["Content type", header.contentTypeName], ["Title ID", hex(header.titleId)],
    ["Media ID", hex(header.mediaId)], ["Version", versionText(header.version)], ["Base version", versionText(header.baseVersion)],
    ["Publisher", header.publisher || "—"], ["Package title", header.packageTitle || "—"],
    ["Recorded content", formatBytes(header.contentSize)], ["Data fragments", header.dataFileCount || "—"]
  ];
  renderMetadata(fields);
  const image = header.contentImage || header.packageImage;
  if (image) {
    const img = document.createElement("img"); img.src = bytesToDataUrl(image, detectImageMime(image)); img.alt = "Package artwork";
    $("artwork").replaceChildren(img);
  } else {
    const mark = document.createElement("span"); mark.textContent = header.signatureType;
    $("artwork").replaceChildren(mark);
  }
}

function renderXzpPackage(archive, file) {
  $("packageTitle").textContent = file.name;
  $("packageSubtitle").textContent = `XZP v${archive.version} resource archive · ${formatBytes(file.size)}`;
  renderMetadata([
    ["Signature", "XUIZ"], ["Format", `XZP version ${archive.version}`],
    ["Files", archive.entries.length.toLocaleString()], ["Archive size", formatBytes(file.size)],
    ["Data offset", `0x${archive.dataOffset.toString(16).toUpperCase()}`]
  ]);
  const mark = document.createElement("span"); mark.textContent = "XZP";
  $("artwork").replaceChildren(mark);
}

function renderRows() {
  const query = $("filter").value.trim().toLowerCase();
  const visible = state.rows.filter(row => {
    if (query) return row.node.path.toLowerCase().includes(query);
    return !row.ancestors.some(path => state.collapsed.has(path));
  });
  const fragment = document.createDocumentFragment();
  for (const row of visible) {
    const tr = document.createElement("tr");
    if (row.node === state.selected) tr.classList.add("selected");
    if (row.node.directory) {
      tr.classList.add("folder");
      tr.setAttribute("aria-expanded", String(!state.collapsed.has(row.node.path)));
      tr.title = state.collapsed.has(row.node.path) ? "Expand folder" : "Collapse folder";
    }
    const name = document.createElement("td");
    name.style.paddingLeft = `${13 + row.depth * 18}px`;
    const marker = row.node.directory ? (state.collapsed.has(row.node.path) ? "▸" : "▾") : "·";
    name.textContent = `${marker} ${row.node.name}`;
    const path = document.createElement("td"); path.className = "path"; path.textContent = row.node.path;
    const size = document.createElement("td"); size.className = "size"; size.textContent = row.node.directory ? "—" : formatBytes(row.node.size);
    tr.append(name, path, size);
    tr.addEventListener("click", () => row.node.directory ? toggleFolder(row.node) : selectNode(row.node));
    fragment.append(tr);
  }
  $("fileRows").replaceChildren(fragment);
  const fileCount = state.rows.filter(row => !row.node.directory).length;
  $("fileSummary").textContent = `${fileCount.toLocaleString()} files`;
}

function toggleFolder(node) {
  selectionGeneration++;
  if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
  else collapseDirectory(node);
  state.selected = node;
  $("extractButton").disabled = true;
  $("verifyButton").disabled = true;
  renderRows();
}

function selectNode(node) {
  const generation = ++selectionGeneration;
  state.selected = node;
  $("extractButton").disabled = node.directory;
  $("verifyButton").disabled = node.directory || typeof node.verify !== "function";
  renderRows();
  renderSelectedNode(node, generation).catch(error => {
    if (generation !== selectionGeneration || node !== state.selected) return;
    showError(error);
    setStatus(`Could not inspect ${node.name}`);
  });
}

function collapseDirectory(node) {
  if (!node.directory) return;
  state.collapsed.add(node.path);
  for (const child of node.children || []) if (child.directory) collapseDirectory(child);
}

async function renderSelectedNode(node, generation) {
  const extension = node.name.includes(".") ? node.name.split(".").pop().toLowerCase() : "";
  if (IMAGE_TYPES.has(extension)) {
    await renderImagePreview(node, IMAGE_TYPES.get(extension), generation);
  } else if (extension === "txt") {
    await renderTextPreview(node, generation);
  } else if (extension === "xex") {
    const bytes = await readNodePrefix(node, MAX_XEX_HEADER_SIZE);
    const xex = parseXex(bytes);
    if (generation !== selectionGeneration || node !== state.selected) return;
    renderXexDetails(node, xex);
  } else {
    closePreview();
  }
}

async function renderTextPreview(node, generation) {
  if (node.size > MAX_TEXT_PREVIEW_SIZE) throw new Error(`Text preview is limited to ${formatBytes(MAX_TEXT_PREVIEW_SIZE)}.`);
  const blob = await collectStream(node.stream(1024 * 1024), MAX_TEXT_PREVIEW_SIZE);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (generation !== selectionGeneration || node !== state.selected) return;
  const decoded = decodeText(bytes);
  const content = document.createElement("pre");
  content.className = "preview-text";
  content.textContent = decoded.text;
  showPreview(node.name, content, createMetadataList([
    ["Path", node.path], ["Type", `text/plain · ${decoded.encoding}`], ["File size", formatBytes(node.size)]
  ]));
}

function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16 LE" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16 BE" };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "UTF-8" };
}

async function renderImagePreview(node, mimeType, generation) {
  if (node.size > MAX_IMAGE_PREVIEW_SIZE) throw new Error(`Image preview is limited to ${formatBytes(MAX_IMAGE_PREVIEW_SIZE)}.`);
  const raw = await collectStream(node.stream(1024 * 1024), MAX_IMAGE_PREVIEW_SIZE);
  if (generation !== selectionGeneration || node !== state.selected) return;
  const dataUrl = await blobToDataUrl(new Blob([raw], { type: mimeType }));
  if (generation !== selectionGeneration || node !== state.selected) return;
  const img = document.createElement("img");
  img.className = "preview-image";
  img.src = dataUrl;
  img.alt = `Preview of ${node.name}`;
  const fields = [["Path", node.path], ["Type", mimeType], ["File size", formatBytes(node.size)]];
  showPreview(node.name, img, createMetadataList(fields));
  img.addEventListener("load", () => {
    if (generation === selectionGeneration && node === state.selected) $("previewBody").replaceChildren(img, createMetadataList([...fields, ["Dimensions", `${img.naturalWidth} × ${img.naturalHeight}`]]));
  }, { once: true });
  img.addEventListener("error", () => {
    if (generation === selectionGeneration && node === state.selected) showPreview(node.name, createMetadataList([...fields, ["Preview", "The browser could not decode this image."]]));
  }, { once: true });
}

function renderXexDetails(node, xex) {
  const mark = document.createElement("div"); mark.className = "xex-preview-mark"; mark.textContent = "XEX";
  const execution = xex.execution;
  const fields = [
    ["Media ID", execution ? `0x${hex(execution.mediaId)}` : "—"],
    ["Title ID", execution ? `0x${hex(execution.titleId)} (${execution.breakdown})` : "—"],
    ["Version", formatXexVersion(execution?.version)],
    ["Base version", formatXexVersion(execution?.baseVersion)],
    ["Original PE name", xex.originalPeName || "—"],
    ["Load address", xex.peBase === null ? "—" : `0x${hex(xex.peBase)}`],
    ["Image size", xex.imageSize === null ? "—" : `0x${hex(xex.imageSize)} · ${formatBytes(xex.imageSize)}`],
    ["File time", formatXexTimestamp(xex.timestamp)]
  ];
  showPreview(node.name, mark, createMetadataList(fields));
}

function renderMetadata(fields) {
  $("metadata").replaceChildren(...fields.flatMap(([term, value]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
}

function createMetadataList(fields) {
  const list = document.createElement("dl");
  list.className = "preview-metadata";
  list.replaceChildren(...fields.flatMap(([term, value]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  return list;
}

function showPreview(title, ...content) {
  $("previewTitle").textContent = title;
  $("previewBody").replaceChildren(...content);
  if (!$("previewDialog").open) $("previewDialog").showModal();
}

function closePreview() {
  if ($("previewDialog").open) $("previewDialog").close();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("The image could not be encoded.")), { once: true });
    reader.readAsDataURL(blob);
  });
}

function bytesToDataUrl(bytes, mimeType) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return "image/png";
}

async function readNodePrefix(node, maximum) {
  const wanted = Math.min(node.size, maximum);
  const result = new Uint8Array(wanted);
  let position = 0;
  for await (const chunk of node.stream(Math.max(0x1000, wanted))) {
    const count = Math.min(chunk.length, wanted - position);
    result.set(chunk.subarray(0, count), position);
    position += count;
    if (position === wanted) break;
  }
  if (position !== wanted) throw new Error(`Could not read the complete ${formatBytes(wanted)} file prefix.`);
  return result;
}

async function extractSelected() {
  const node = state.selected;
  if (!node || node.directory) return;
  try {
    setStatus(`Extracting ${node.name}…`);
    await saveFile(node);
    setStatus(`Extracted ${node.name}`);
  } catch (error) { showError(error); setStatus("Extraction failed"); }
}

async function saveFile(node) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: safeName(node.name) });
    const writable = await handle.createWritable();
    try {
      let written = 0;
      for await (const chunk of node.stream()) {
        await writable.write(chunk);
        written += chunk.length;
        setStatus(`Extracting ${node.name} · ${Math.floor(written * 100 / Math.max(1, node.size))}%`);
      }
      await writable.close();
    } catch (error) { await writable.abort(error); throw error; }
    return;
  }
  const blob = await collectStream(node.stream());
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = safeName(node.name); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function extractAll() {
  if (!window.showDirectoryPicker) {
    showError(new Error("Extract All needs the streaming directory API. Open this GitHub Page in current Chrome or Edge. Individual small files can still be downloaded in other browsers."));
    return;
  }
  try {
    const destination = await window.showDirectoryPicker({ mode: "readwrite" });
    const rootName = safeName(state.header?.displayTitle || state.header?.packageTitle || state.package?.name || "OpenCON extraction");
    const rootHandle = await destination.getDirectoryHandle(rootName, { create: true });
    let completed = 0;
    const total = state.rows.filter(row => !row.node.directory).length;
    await writeChildren(state.package.root.children, rootHandle, () => {
      completed++;
      setStatus(`Extracting all · ${completed}/${total} files`);
    });
    setStatus(`Extracted ${completed} files`);
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
    setStatus(error.name === "AbortError" ? "Extraction cancelled" : "Extraction failed");
  }
}

async function writeChildren(nodes, directoryHandle, onFile) {
  for (const node of nodes) {
    if (node.directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(safeName(node.name), { create: true });
      await writeChildren(node.children, childHandle, onFile);
    } else {
      const fileHandle = await directoryHandle.getFileHandle(safeName(node.name), { create: true });
      const writable = await fileHandle.createWritable();
      try {
        for await (const chunk of node.stream()) await writable.write(chunk);
        await writable.close();
      } catch (error) { await writable.abort(error); throw error; }
      onFile();
    }
  }
}

async function verifySelected() {
  const node = state.selected;
  if (!node?.verify) return;
  try {
    setStatus(`Verifying ${node.name}…`);
    const result = await node.verify();
    if (!result.ok) throw new Error(`${node.path} failed its SHA-1 block hash at STFS block 0x${result.block.toString(16).toUpperCase()}.`);
    setStatus(`${node.name}: ${result.checked} block hashes valid`);
  } catch (error) { showError(error); setStatus("Verification failed"); }
}

function setStatus(message) { $("status").textContent = message; }
function showError(error) {
  $("errorText").textContent = error?.stack || String(error);
  $("errorDialog").showModal();
}
