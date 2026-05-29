import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const root = process.cwd();
const distDir = join(root, "dist");
const releaseDir = join(root, "release");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestPath = join(distDir, "manifest.json");

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(dir) {
  return readdirSync(dir)
    .flatMap((entry) => {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      return stats.isDirectory() ? listFiles(fullPath) : [fullPath];
    })
    .sort((a, b) => a.localeCompare(b));
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`${label} is missing or empty: ${path}`);
  }
}

function assertManifestIconSet(iconSet, label) {
  for (const size of ["16", "32", "48", "128"]) {
    if (!iconSet?.[size]) {
      throw new Error(`${label} is missing the ${size}px icon`);
    }
    assertFile(join(distDir, iconSet[size]), `${label} ${size}px icon`);
  }
}

function validateDist() {
  assertFile(manifestPath, "Manifest");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) {
    throw new Error("Chrome Web Store package must use Manifest V3");
  }

  const permissions = new Set(manifest.permissions ?? []);
  for (const permission of ["history"]) {
    if (permissions.has(permission)) {
      throw new Error(`Chrome Web Store v1 package must not request ${permission}`);
    }
  }

  if ((manifest.host_permissions ?? []).includes("http://*/*")) {
    throw new Error("Chrome Web Store v1 package must not request http://*/* host access");
  }

  assertManifestIconSet(manifest.icons, "manifest.icons");
  assertManifestIconSet(manifest.action?.default_icon, "action.default_icon");
  assertFile(join(distDir, manifest.background?.service_worker ?? ""), "background service worker");
  assertFile(join(distDir, manifest.side_panel?.default_path ?? ""), "side panel HTML");

  const sourcemaps = listFiles(distDir).filter((file) => file.endsWith(".map"));
  if (sourcemaps.length > 0) {
    throw new Error(`Release build contains sourcemaps: ${sourcemaps.map((file) => relative(distDir, file)).join(", ")}`);
  }
}

function sanitizeManifestForStore() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.key === undefined) {
    return;
  }

  delete manifest.key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function writeZip(outputPath, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const relativePath = relative(distDir, file).split(sep).join("/");
    const name = Buffer.from(relativePath);
    const data = readFileSync(file);
    const stats = statSync(file);
    const { dosDate, dosTime } = dosDateTime(stats.mtime);
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
}

validateDist();
sanitizeManifestForStore();

const files = listFiles(distDir);
const packageName = `${packageJson.name}-${packageJson.version}-chrome-extension.zip`;
const outputPath = join(releaseDir, packageName);
writeZip(outputPath, files);

console.log(`Packaged ${files.length} files into ${relative(root, outputPath)}`);
console.log(`Chrome Web Store zip root: ${basename(manifestPath)}`);
