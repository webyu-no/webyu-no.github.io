// One atomic snapshot contains every FLAGxx file, including shared progress.
export const SAVE_FORMAT = 'web-yuno-flags-v1';
const SAVE_SIZE = 8192;
const validName = /^FLAG\d{2}$/;
const exportedNames = new Set(['FLAG00', ...[1, 2, 3].flatMap(slot =>
  Array.from({length: 9}, (_, part) => 'FLAG' + slot + part))]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()};
}

function put16(view, offset, value) { view.setUint16(offset, value, true); }
function put32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

// A small ZIP "store" writer keeps exports dependency-free and readable by
// desktop archive tools. Compression is unnecessary for 8 KiB flag files.
export function encodeSaveZip(files) {
  const checked = validateSaveBundle(encodeSaveBundle(files));
  if (Object.keys(checked).length !== exportedNames.size ||
      Object.keys(checked).some(name => !exportedNames.has(name)))
    throw new Error('The complete Web YU-NO save set is not available.');
  const entries = [['webyuno', new Uint8Array()], ...Object.entries(checked).sort()];
  const {time, date} = dosDateTime();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const header = new Uint8Array(30 + nameBytes.length), view = new DataView(header.buffer);
    put32(view, 0, 0x04034b50); put16(view, 4, 20); put16(view, 6, 0x800);
    put16(view, 8, 0); put16(view, 10, time); put16(view, 12, date);
    put32(view, 14, crc32(bytes)); put32(view, 18, bytes.length); put32(view, 22, bytes.length);
    put16(view, 26, nameBytes.length); put16(view, 28, 0); header.set(nameBytes, 30);
    chunks.push(header, bytes);
    const directory = new Uint8Array(46 + nameBytes.length), dir = new DataView(directory.buffer);
    put32(dir, 0, 0x02014b50); put16(dir, 4, 20); put16(dir, 6, 20); put16(dir, 8, 0x800);
    put16(dir, 10, 0); put16(dir, 12, time); put16(dir, 14, date); put32(dir, 16, crc32(bytes));
    put32(dir, 20, bytes.length); put32(dir, 24, bytes.length); put16(dir, 28, nameBytes.length);
    put16(dir, 30, 0); put16(dir, 32, 0); put16(dir, 34, 0); put16(dir, 36, 0);
    put32(dir, 38, 0); put32(dir, 42, offset); directory.set(nameBytes, 46);
    central.push(directory); offset += header.length + bytes.length;
  }
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  put32(endView, 0, 0x06054b50); put16(endView, 8, entries.length); put16(endView, 10, entries.length);
  put32(endView, 12, centralSize); put32(endView, 16, offset);
  return new Uint8Array(chunks.concat(central, [end]).reduce((all, chunk) => {
    const result = new Uint8Array(all.length + chunk.length); result.set(all); result.set(chunk, all.length); return result;
  }, new Uint8Array()));
}

export function decodeSaveZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {}, names = new Set(); let marker = false, position = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { position = i; break; }
  }
  if (position < 0 || position + 22 > bytes.length) throw new Error('This is not a Web YU-NO ZIP archive.');
  const count = view.getUint16(position + 10, true), centralSize = view.getUint32(position + 12, true);
  const centralOffset = view.getUint32(position + 16, true);
  const commentLength = view.getUint16(position + 20, true);
  if (count !== exportedNames.size + 1 || centralOffset + centralSize !== position ||
      position + 22 + commentLength !== bytes.length)
    throw new Error('Invalid Web YU-NO ZIP archive.');
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid Web YU-NO ZIP directory.');
    const method = view.getUint16(cursor + 10, true), compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (names.has(name) || name.includes('/') || name.includes('\\') || method !== 0)
      throw new Error('Unsupported or unsafe file in Web YU-NO ZIP archive.');
    names.add(name);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50)
      throw new Error('Invalid Web YU-NO ZIP entry.');
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = new TextDecoder().decode(bytes.slice(localOffset + 30, localOffset + 30 + localNameLength));
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (localName !== name || start + compressed > centralOffset) throw new Error('Invalid Web YU-NO ZIP entry.');
    if (name === 'webyuno') {
      if (size !== 0 || compressed !== 0 || crc32(bytes.slice(start, start)) !== view.getUint32(cursor + 16, true))
        throw new Error('Invalid Web YU-NO marker.');
      marker = true;
    }
    else {
      if (!validName.test(name) || !exportedNames.has(name) || size !== SAVE_SIZE || compressed !== size)
        throw new Error('Invalid flag file: ' + name);
      const content = bytes.slice(start, start + size);
      if (crc32(content) !== view.getUint32(cursor + 16, true)) throw new Error('Corrupt flag file: ' + name);
      files[name] = content;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!marker || Object.keys(files).length !== exportedNames.size ||
      [...exportedNames].some(name => !files[name]))
    throw new Error('This is not a complete Web YU-NO save archive.');
  if (new TextDecoder('ascii').decode(files.FLAG00.slice(0, 12)) !== 'FLAGINI.MES\0')
    throw new Error('FLAG00 is not an initialized Web YU-NO save.');
  return validateSaveBundle(encodeSaveBundle(files));
}

export function validateSaveBundle(bundle) {
  if (!bundle || bundle.format !== SAVE_FORMAT || !bundle.files || Array.isArray(bundle.files))
    throw new Error('This is not a Web YU-NO save backup.');
  const entries = Object.entries(bundle.files);
  if (entries.length > 100) throw new Error('Too many flag files.');
  const files = {};
  for (const [name, encoded] of entries) {
    if (!validName.test(name) || typeof encoded !== 'string' || encoded.length > 10924)
      throw new Error(`Invalid flag file: ${name}`);
    const binary = atob(encoded);
    if (binary.length !== SAVE_SIZE) throw new Error(`${name} must contain exactly 8,192 bytes.`);
    files[name] = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  }
  return files;
}

export function encodeSaveBundle(files) {
  return { format: SAVE_FORMAT, files: Object.fromEntries(Object.entries(files).sort().map(([name, bytes]) =>
    [name, btoa(String.fromCharCode(...bytes))])) };
}

export class SaveStore {
  constructor(report, namespace = location.pathname.replace(/[^/]*$/, '')) {
    this.report = report;
    this.key = `web-yuno:${namespace}:flags-v1`;
    this.db = null;
    this.last = null;
    this.revision = 0;
    this.queue = Promise.resolve();
  }

  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(this.key, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('saves');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Save storage is open in another tab.'));
      });
      this.db.onversionchange = () => this.db.close();
    } catch (error) {
      this.report('IndexedDB unavailable; using local browser storage.');
    }
    // A synchronous journal also protects the latest write if the tab closes
    // before its IndexedDB transaction finishes.
    let bundle, databaseBundle;
    try { bundle = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch {}
    if (this.db) {
      try {
        databaseBundle = await new Promise((resolve, reject) => {
          const request = this.db.transaction('saves').objectStore('saves').get('all');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        if (!bundle) throw error;
      }
    }
    // If a journal write hit its quota but IndexedDB succeeded, the database
    // is newer. If the tab closed before a transaction, the journal is newer.
    if (databaseBundle && (!bundle || (databaseBundle.revision || 0) > (bundle.revision || 0)))
      bundle = databaseBundle;
    if (!bundle) return {};
    const files = validateSaveBundle(bundle);
    this.revision = bundle.revision || 0;
    this.last = JSON.stringify(encodeSaveBundle(files));
    return files;
  }

  save(files) {
    const bundle = encodeSaveBundle(files);
    validateSaveBundle(bundle);
    const serialized = JSON.stringify(bundle);
    if (serialized === this.last) return this.queue;
    bundle.revision = this.revision = Math.max(Date.now(), this.revision + 1);
    let journaled = false;
    try { localStorage.setItem(this.key, JSON.stringify(bundle)); journaled = true; } catch {}
    this.report('Saving progress…');
    const commit = async () => {
      let stored = false;
      if (this.db) {
        try {
          await new Promise((resolve, reject) => {
            const transaction = this.db.transaction('saves', 'readwrite');
            transaction.objectStore('saves').put(bundle, 'all');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          stored = true;
        } catch {}
      }
      if (!stored && !journaled) {
        this.report('Progress could not be saved. Free browser storage before closing this tab.');
        this.last = null;
        throw new Error('Browser storage is unavailable or full. Free storage and try again.');
      }
      this.report(stored ? 'Progress saved' : 'Progress saved in local storage');
    };
    this.last = serialized;
    this.queue = this.queue.catch(() => {}).then(commit);
    return this.queue;
  }
}
