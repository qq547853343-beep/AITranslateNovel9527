import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'browser-extension');
const outputDirectory = path.join(root, 'dist');
const packageValue = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const outputPath = path.join(outputDirectory, `AITranslateNovel9527-browser-extension-${packageValue.version}.zip`);
const zip = new JSZip();

async function addDirectory(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirectory(absolutePath, archivePath);
    else if (entry.isFile()) zip.file(archivePath, await fs.readFile(absolutePath));
  }
}

await addDirectory(sourceDirectory);
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
console.log(outputPath);
