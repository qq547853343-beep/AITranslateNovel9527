import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class StagedAssetStore {
  constructor({ assetDirectory, temporaryDirectory = path.join(path.dirname(assetDirectory), 'import-tmp') }) {
    this.assetDirectory = assetDirectory;
    this.temporaryDirectory = temporaryDirectory;
    fs.mkdirSync(assetDirectory, { recursive: true });
    fs.mkdirSync(temporaryDirectory, { recursive: true });
  }

  begin() { return new AssetImportSession(this); }
}

class AssetImportSession {
  constructor(store) {
    this.store = store;
    this.directory = fs.mkdtempSync(path.join(store.temporaryDirectory, 'web-package-'));
    this.staged = [];
    this.committed = [];
    this.closed = false;
  }

  stage(buffer, format) {
    if (this.closed) throw new Error('资源导入会话已关闭。');
    const assetId = `${randomUUID()}.${format.extension}`;
    const temporary = path.join(this.directory, assetId);
    fs.writeFileSync(temporary, buffer, { flag: 'wx', mode: 0o600 });
    const record = { assetId, mime: format.mime, temporary, destination: path.join(this.store.assetDirectory, assetId) };
    this.staged.push(record);
    return { assetId, mime: format.mime, url: `/api/assets/${assetId}` };
  }

  commit() {
    try {
      for (const record of this.staged) { fs.renameSync(record.temporary, record.destination); this.committed.push(record.destination); }
      this.closed = true;
      fs.rmSync(this.directory, { recursive: true, force: true });
    } catch (error) {
      this.rollback();
      const wrapped = new Error(`资源提交失败，已回滚：${error.message}`);
      wrapped.code = 'WEB_PACKAGE_ASSET_COMMIT_FAILED'; wrapped.status = 500;
      throw wrapped;
    }
  }

  rollback() {
    for (const file of this.committed) try { fs.unlinkSync(file); } catch {}
    this.closed = true;
    try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch {}
  }
}
