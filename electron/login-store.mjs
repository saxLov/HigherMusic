import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
// The renderer never receives the token, device cookie, or encrypted envelope.
export function createLoginStore(directory, crypto, mode) {
  const file = path.join(directory, `login-${mode === 'lite' ? 'lite' : 'standard'}.json`);
  let queue = Promise.resolve();
  const serialize = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const available = () => crypto.isAsyncEncryptionAvailable ? crypto.isAsyncEncryptionAvailable() : crypto.isEncryptionAvailable();
  const encrypt = text => crypto.encryptStringAsync ? crypto.encryptStringAsync(text) : crypto.encryptString(text);
  const decrypt = bytes => crypto.decryptStringAsync ? crypto.decryptStringAsync(bytes) : crypto.decryptString(bytes);
  return {
    available,
    load: () => serialize(async () => {
      try {
        if (!await available()) return null;
        const envelope = JSON.parse(await readFile(file, 'utf8'));
        if (envelope.version !== 1 || typeof envelope.encrypted !== 'string' || envelope.encrypted.length > 200000) return null;
        const decoded = await decrypt(Buffer.from(envelope.encrypted, 'base64'));
        const record = JSON.parse(typeof decoded === 'string' ? decoded : decoded.result ?? decoded.decryptedString);
        if (!record.jar?.token || !record.jar?.userid) return null;
        return record;
      } catch { return null; }
    }),
    save: record => serialize(async () => {
      if (!await available()) throw new Error('系统加密暂不可用，本次登录不会保存');
      const text = JSON.stringify(record);
      if (text.length > 64000) throw new Error('登录资料无法保存，请重新扫码');
      const encrypted = await encrypt(text);
      const bytes = Buffer.isBuffer(encrypted) ? encrypted : encrypted.result ?? encrypted.encryptedData;
      await mkdir(directory, { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify({ version: 1, encrypted: Buffer.from(bytes).toString('base64') }), { mode: 0o600 });
      await rename(file + '.tmp', file);
    }),
    clear: () => serialize(async () => { await rm(file, { force: true }); await rm(file + '.tmp', { force: true }); }),
  };
}
