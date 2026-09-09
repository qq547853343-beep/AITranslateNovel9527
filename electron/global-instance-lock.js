import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function acquireGlobalInstanceLock(lockFile, { pid = process.pid, isProcessAlive = processIsAlive } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const ownerToken = randomUUID();
  const record = { pid: Number(pid), ownerToken, executable: process.execPath, createdAt: new Date().toISOString() };

  const create = () => {
    const descriptor = fs.openSync(lockFile, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8'); }
    finally { fs.closeSync(descriptor); }
  };

  try {
    create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
    if (existing?.pid && isProcessAlive(Number(existing.pid))) {
      return { acquired: false, existingPid: Number(existing.pid), release() {} };
    }
    try { fs.unlinkSync(lockFile); } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') return { acquired: false, existingPid: Number(existing?.pid) || null, release() {} };
    }
    try { create(); }
    catch (retryError) {
      if (retryError?.code === 'EEXIST') return { acquired: false, existingPid: null, release() {} };
      throw retryError;
    }
  }

  let released = false;
  return {
    acquired: true,
    existingPid: null,
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.ownerToken === ownerToken && Number(current.pid) === Number(pid)) fs.unlinkSync(lockFile);
      } catch {}
    }
  };
}
