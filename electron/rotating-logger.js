import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)sk-[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|token)"?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]');
}

export class RotatingLogger {
  constructor(directory, { maxBytes = 10 * 1024 * 1024, maxHistory = 5, retentionDays = 7, clock = () => new Date() } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxHistory = maxHistory;
    this.retentionDays = retentionDays;
    this.clock = clock;
    fs.mkdirSync(directory, { recursive: true });
    this.cleanup();
  }

  launcher(level, message, meta) { this.#write('launcher', level, message, meta); }
  service(level, message, meta) { this.#write('service', level, message, meta); }

  writeServiceChunk(level, chunk) {
    for (const line of redactSecrets(chunk).split(/\r?\n/)) if (line.trim()) this.service(level, line);
  }

  readRecent(kind = 'all', lineLimit = 200) {
    const allowed = ['launcher', 'service', 'all'];
    const selected = allowed.includes(kind) ? kind : 'all';
    const files = fs.readdirSync(this.directory)
      .filter((name) => name.endsWith('.log') || /\.log\.\d+$/.test(name))
      .filter((name) => selected === 'all' || name.startsWith(selected))
      .map((name) => ({ name, file: path.join(this.directory, name), stat: fs.statSync(path.join(this.directory, name)) }))
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    const lines = [];
    for (const item of files) {
      const size = Math.min(item.stat.size, 512 * 1024);
      if (!size) continue;
      const descriptor = fs.openSync(item.file, 'r');
      try {
        const buffer = Buffer.alloc(size);
        fs.readSync(descriptor, buffer, 0, size, item.stat.size - size);
        lines.push(...redactSecrets(buffer.toString('utf8')).split(/\r?\n/).filter(Boolean));
      } finally { fs.closeSync(descriptor); }
    }
    return lines.slice(-Math.max(1, Math.min(2000, Number(lineLimit) || 200)));
  }

  cleanup() {
    const cutoff = this.clock().getTime() - this.retentionDays * DAY;
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.startsWith('launcher') && !name.startsWith('service-')) continue;
      const file = path.join(this.directory, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
    }
  }

  #write(kind, level, message, meta) {
    try {
      const timestamp = this.clock();
      const date = timestamp.toISOString().slice(0, 10);
      const name = kind === 'service' ? `service-${date}.log` : 'launcher.log';
      const file = path.join(this.directory, name);
      fs.mkdirSync(this.directory, { recursive: true });
      this.#rotate(file);
      const suffix = meta == null ? '' : ` ${JSON.stringify(meta)}`;
      const line = `${timestamp.toISOString()} [${String(level || 'INFO').toUpperCase()}] ${redactSecrets(message)}${redactSecrets(suffix)}\n`;
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never crash the launcher during shutdown or filesystem failures.
    }
  }

  #rotate(file) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size < this.maxBytes) return;
    const oldest = `${file}.${this.maxHistory}`;
    try { if (fs.existsSync(oldest)) fs.unlinkSync(oldest); } catch {}
    for (let index = this.maxHistory - 1; index >= 1; index -= 1) {
      const source = `${file}.${index}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${file}.${index + 1}`);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  }
}
