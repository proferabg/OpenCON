const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const [binary, headerModule, sourceModule, stfsModule, svodModule, xdvdfsModule] = await Promise.all([
  import(`./binary.js?v=${moduleVersion}`),
  import(`./header.js?v=${moduleVersion}`),
  import(`./source.js?v=${moduleVersion}`),
  import(`./stfs.js?v=${moduleVersion}`),
  import(`./svod.js?v=${moduleVersion}`),
  import(`./xdvdfs.js?v=${moduleVersion}`)
]);
const { formatBytes, hex, safeName } = binary;
const { readPackageHeader, versionText } = headerModule;
const { BlobSource, collectStream } = sourceModule;
const { StfsPackage } = stfsModule;
const { fragmentsFromMonolith, SvodIsoSource } = svodModule;
const { XdvdfsVolume } = xdvdfsModule;

const $ = (id) => document.getElementById(id);
const state = { package: null, header: null, rows: [], selected: null, artworkUrl: null, collapsed: new Set() };
let openGeneration = 0;
let dragDepth = 0;

$("openFiles").addEventListener("click", () => $("fileInput").click());
$("openFolder").addEventListener("click", () => $("folderInput").click());
$("fileInput").addEventListener("change", (event) => { openFiles([...event.target.files]); event.target.value = ""; });
$("folderInput").addEventListener("change", (event) => { openFiles([...event.target.files]); event.target.value = ""; });
$("filter").addEventListener("input", renderRows);
$("extractButton").addEventListener("click", extractSelected);
$("extractAllButton").addEventListener("click", extractAll);
$("verifyButton").addEventListener("click", verifySelected);

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
    if (!headerFile) throw new Error("No CON, LIVE, or PIRS package header was found. For split GoD content, select the header and its .data folder together.");
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
  $("metadata").replaceChildren(...fields.flatMap(([term, value]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  if (state.artworkUrl) URL.revokeObjectURL(state.artworkUrl);
  const image = header.contentImage || header.packageImage;
  if (image) {
    state.artworkUrl = URL.createObjectURL(new Blob([image]));
    const img = document.createElement("img"); img.src = state.artworkUrl; img.alt = "Package artwork";
    $("artwork").replaceChildren(img);
  } else {
    const mark = document.createElement("span"); mark.textContent = header.signatureType;
    $("artwork").replaceChildren(mark);
  }
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
  if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
  else state.collapsed.add(node.path);
  state.selected = node;
  $("extractButton").disabled = true;
  $("verifyButton").disabled = true;
  renderRows();
}

function selectNode(node) {
  state.selected = node;
  $("extractButton").disabled = node.directory;
  $("verifyButton").disabled = node.directory || typeof node.verify !== "function";
  renderRows();
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
    const rootName = safeName(state.header.displayTitle || state.header.packageTitle || "OpenCON extraction");
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
