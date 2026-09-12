import {SaveStore, encodeSaveZip, decodeSaveZip} from './storage.js?v=20260912.4';
import {Renderer, fitViewport} from './renderer.js?v=20260912.4';
import {BrowserAudio} from './audio.js?v=20260912.4';
import {nextTimelineMusic} from './music-timeline.js?v=20260912.4';

const $ = id => document.getElementById(id);
const engine = $('canvas');
const release = '20260912.4';
const preferenceKey = `web-yuno:${location.pathname.replace(/[^/]*$/, '')}:settings-v2`;
const saveSeedKey = `web-yuno:${location.pathname.replace(/[^/]*$/, '')}:save-seed-v1`;
const firefoxLinux = /Firefox\//.test(navigator.userAgent) && /Linux/.test(navigator.userAgent);
const mobileOrTablet = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
let preferences = {pointer: firefoxLinux ? 1 : 0, speed: 100, scaling: 0};
try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey));
  if (saved) {
    if (Number.isInteger(saved.speed) && saved.speed >= 25 && saved.speed <= 400) preferences.speed = saved.speed;
    if ([0,1,2,3].includes(saved.scaling)) preferences.scaling = saved.scaling;
    if ([0,1].includes(saved.pointer)) preferences.pointer = saved.pointer;
  }
} catch {}
// Rewrite older settings objects into the current three-setting schema.
try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch {}
const status = message => { if (message) console.info(message); };
const store = new SaveStore(status);
let renderer;
let started = false;
let ready = false;
let cachedBytes = 0;
const batchCache = new Map();
let protectedBatches = new Set();
let residentBatches = new Set();
const pendingBatches = new Map();
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_WARNING_MS = 3000;
const DOWNLOAD_STALL_MS = 15000;
const DOWNLOAD_ATTEMPTS = 10;
const slowDownloads = new Set();
let blockingLoads = 0;
const SPECULATIVE_CONCURRENCY = 2;
let prefetchScheduler = null;
let prefetchWorker = null;
const workerJobs = new Map();
const ASSET_CACHE_NAME = `web-yuno-verified-assets-v1:${location.pathname.replace(/[^a-z0-9]/gi, '_')}`;
const ASSET_CACHE_LIMIT = 1024 * 1024 * 1024;
const assetCacheMetadataKey = `web-yuno:${location.pathname.replace(/[^/]*$/, '')}:asset-cache-v1`;
const persistentAssets = {
  cache: null,
  metadata: {},
  budget: 0,
  key(entry) { return new URL(entry.url, location.href).href; },
  saveMetadata() {
    try { localStorage.setItem(assetCacheMetadataKey, JSON.stringify(this.metadata)); } catch {}
  },
  touch(entry) {
    this.metadata[this.key(entry)] = {size: entry.storedSize, used: Date.now()};
    this.saveMetadata();
  },
  async prepare(entries) {
    if (!globalThis.caches) return;
    try {
      this.cache = await caches.open(ASSET_CACHE_NAME);
      try { this.metadata = JSON.parse(localStorage.getItem(assetCacheMetadataKey)) || {}; }
      catch { this.metadata = {}; }
      const estimate = await navigator.storage?.estimate?.() || null;
      // Keep the asset cache bounded independently of saves and leave most of
      // the origin quota available to the browser.  Desktop origins can retain
      // the whole game; tighter mobile quotas retain the most recently useful
      // scene context.
      this.budget = Math.min(ASSET_CACHE_LIMIT,
        Math.floor((estimate?.quota || ASSET_CACHE_LIMIT) * 0.5));
      const valid = new Set(entries.map(entry => this.key(entry)));
      for (const request of await this.cache.keys()) {
        if (!valid.has(request.url)) {
          await this.cache.delete(request);
          delete this.metadata[request.url];
        }
      }
      for (const key of Object.keys(this.metadata)) if (!valid.has(key)) delete this.metadata[key];
      this.saveMetadata();
    } catch (error) {
      console.warn('Persistent asset cache is unavailable', error);
      this.cache = null;
    }
  },
  async match(entry) {
    if (!this.cache) return null;
    try {
      const response = await this.cache.match(this.key(entry));
      if (response) this.touch(entry);
      return response || null;
    } catch { return null; }
  },
  async remove(entry) {
    if (!this.cache) return;
    const key = this.key(entry);
    try { await this.cache.delete(key); } catch {}
    delete this.metadata[key]; this.saveMetadata();
  },
  async put(entry, response) {
    if (!this.cache || entry.storedSize > this.budget) return;
    const key = this.key(entry);
    let used = Object.values(this.metadata).reduce((total, item) => total + (item.size || 0), 0);
    const previous = this.metadata[key]?.size || 0;
    used -= previous;
    if (used + entry.storedSize > this.budget) {
      const oldest = Object.entries(this.metadata).filter(([url]) => url !== key)
        .sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
      for (const [url, item] of oldest) {
        await this.cache.delete(url);
        delete this.metadata[url];
        used -= item.size || 0;
        if (used + entry.storedSize <= this.budget) break;
      }
    }
    try {
      await this.cache.put(key, response);
      this.touch(entry);
    } catch (error) {
      // Quota and private-mode failures must never prevent demand loading.
      console.warn('Could not retain downloaded asset pack', error);
    }
  },
};

function retainPersistent(entry, response) {
  const storeWhenQuiet = () => {
    if (blockingLoads) {
      setTimeout(storeWhenQuiet, 250);
      return;
    }
    persistentAssets.put(entry, response).catch(error =>
      console.warn('Could not retain downloaded asset pack', error));
  };
  // Persistent reuse is useful across sessions but unrelated to whether the
  // current scene is runtime-ready. Keep storage bookkeeping away from frame
  // and demand-load callbacks whenever the browser exposes an idle queue.
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(storeWhenQuiet, {timeout: 5000});
  else
    setTimeout(storeWhenQuiet, 0);
}

function failure(error) {
  console.error(error);
  $('loading-progress').style.width = '100%';
}

function updateDownloadIndicator() {
  $('download-indicator').hidden = !ready || slowDownloads.size === 0;
}

async function responseBytes(response, progress = () => {}) {
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${response.url}`);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      chunks.push(value); size += value.length; progress();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    progress();
    return bytes;
  }
}

async function decodeBytes(encoded, compressed) {
  let bytes = encoded;
  // Some hosts add Content-Encoding themselves. Avoid decompressing twice.
  if (compressed && bytes[0] === 31 && bytes[1] === 139) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function decodedResponse(response, compressed, progress = () => {}) {
  return decodeBytes(await responseBytes(response, progress), compressed);
}

async function verifyBytes(entry, bytes) {
  if (bytes.length !== entry.size) throw new Error(`Incomplete download: ${entry.url}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== entry.sha256) throw new Error(`Asset verification failed: ${entry.url}`);
  return bytes;
}

function decodeInWorker(id, encoded, entry) {
  if (!prefetchWorker) return null;
  return new Promise((resolve, reject) => {
    workerJobs.set(id, {resolve, reject});
    try {
      prefetchWorker.postMessage({type: 'decode', id, buffer: encoded.buffer,
        compressed: entry.encoding === 'gzip', size: entry.size, sha256: entry.sha256},
      [encoded.buffer]);
    } catch (error) {
      workerJobs.delete(id); reject(error);
    }
  });
}

function startPrefetchWorker() {
  if (typeof Worker !== 'function') return;
  try {
    prefetchWorker = new Worker(`prefetch-worker.js?v=${release}`, {type: 'module'});
    prefetchWorker.onmessage = ({data}) => {
      const job = workerJobs.get(data?.id);
      if (!job) return;
      workerJobs.delete(data.id);
      if (data.type === 'ready') job.resolve(new Uint8Array(data.buffer));
      else job.reject(new Error(data.message || `Speculative decode failed: ${data.id}`));
    };
    prefetchWorker.onerror = error => {
      for (const job of workerJobs.values()) job.reject(error.error || error);
      workerJobs.clear();
      prefetchWorker.terminate(); prefetchWorker = null;
    };
  } catch (error) {
    console.warn('Speculative decode worker is unavailable', error);
    prefetchWorker = null;
  }
}

async function decodeAndVerify(entry, encoded, loadState) {
  if (loadState.speculative && prefetchWorker) {
    // Ownership of encoded.buffer moves to the worker. A worker failure causes
    // the surrounding fetch retry path to obtain a fresh response.
    return await decodeInWorker(entry.url, encoded, entry);
  }
  return verifyBytes(entry, await decodeBytes(encoded, entry.encoding === 'gzip'));
}

async function fetchEntry(entry, persistent = false,
                          loadState = {blocking: false, speculative: false}) {
  const operation = Symbol(entry.url);
  const startedAt = performance.now();
  let warning;
  let pausedPromise = null;
  let blockingRegistered = false;
  const showWarning = () => {
    slowDownloads.add(operation);
    updateDownloadIndicator();
  };
  const promote = () => {
    clearTimeout(warning);
    if (!blockingRegistered) {
      blockingRegistered = true;
      blockingLoads++;
    }
    if (!pausedPromise && ready) pausedPromise = api.audio.pauseForLoad();
    const remaining = DOWNLOAD_WARNING_MS - (performance.now() - startedAt);
    if (remaining <= 0) showWarning();
    else warning = setTimeout(showWarning, remaining);
  };
  loadState.promote = promote;
  if (loadState.blocking) promote();
  let lastError;
  try {
    if (persistent) {
      const cached = await persistentAssets.match(entry);
      if (cached) {
        try {
          const encoded = await responseBytes(cached);
          return await decodeAndVerify(entry, encoded, loadState);
        }
        catch (error) {
          console.warn(`Discarding corrupt cached pack: ${entry.url}`, error);
          await persistentAssets.remove(entry);
        }
      }
    }
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      let stall;
      const resetStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(new DOMException(
          `Download stalled: ${entry.url}`, 'TimeoutError')), DOWNLOAD_STALL_MS);
      };
      resetStall();
      try {
        const response = await fetch(entry.url, {
          signal: controller.signal,
          cache: attempt === 1 ? 'default' : 'reload',
          // Supported browsers can keep speculative transfer below assets the
          // VM is actively awaiting; unknown fetch options are safely ignored.
          priority: loadState.speculative && !loadState.blocking ? 'low' : 'high'
        });
        const retained = persistent && persistentAssets.cache ? response.clone() : null;
        const encoded = await responseBytes(response, resetStall);
        clearTimeout(stall);
        const bytes = await decodeAndVerify(entry, encoded, loadState);
        // Persistence is deliberately not on the demand-load critical path.
        // Cache.put consumes the cloned encoded response in the background.
        if (retained) retainPersistent(entry, retained);
        return bytes;
      } catch (error) {
        clearTimeout(stall); lastError = error;
        if (attempt === DOWNLOAD_ATTEMPTS) break;
        console.warn(`Retrying ${entry.url} (${attempt}/${DOWNLOAD_ATTEMPTS})`, error);
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 3000)));
      }
    }
    throw new Error(`Download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${entry.url}: ${lastError?.message || lastError}`);
  } finally {
    clearTimeout(warning);
    loadState.promote = null;
    slowDownloads.delete(operation); updateDownloadIndicator();
    if (pausedPromise) await api.audio.resumeForLoad(await pausedPromise);
    if (blockingRegistered) {
      blockingLoads = Math.max(0, blockingLoads - 1);
      prefetchScheduler?.schedule();
    }
  }
}

function rememberBatch(id, bytes) {
  if (batchCache.has(id)) {
    cachedBytes -= batchCache.get(id).length;
    batchCache.delete(id);
  }
  while (cachedBytes + bytes.length > MAX_CACHE_BYTES && batchCache.size) {
    const oldest = [...batchCache.keys()].find(candidate =>
      !residentBatches.has(candidate) && !protectedBatches.has(candidate));
    // Do not discard the active/nearby scene working set merely to retain a
    // low-priority voice or distant branch. Exact asset bytes have already
    // been returned to the engine even when their source batch is not retained.
    if (!oldest) return;
    cachedBytes -= batchCache.get(oldest).length;
    batchCache.delete(oldest);
  }
  if (bytes.length <= MAX_CACHE_BYTES) {
    batchCache.set(id, bytes);
    cachedBytes += bytes.length;
  }
}

async function fetchBatch(id, speculative = false, blocking = false) {
  if (batchCache.has(id)) {
    const bytes = batchCache.get(id);
    batchCache.delete(id);
    batchCache.set(id, bytes);
    return bytes;
  }
  if (pendingBatches.has(id)) {
    const pending = pendingBatches.get(id);
    if (blocking) {
      pending.state.blocking = true;
      pending.state.promote?.();
    }
    return pending.promise;
  }
  const entry = api.manifest.batches[id];
  if (!entry) throw new Error(`Unknown asset pack: ${id}`);
  const state = {blocking, speculative, promote: null};
  const promise = (async () => {
    if (!speculative) status(`Loading ${entry.group || id}…`);
    const bytes = await fetchEntry(entry, true, state);
    rememberBatch(id, bytes);
    api.downloads.push(id);
    if (!speculative) {
      status('Web YU-NO');
      // Keep the physical-neighbor fallback for dynamically computed names,
      // but route it through the bounded scheduler. A scene context can later
      // raise the priority of its real outgoing destinations.
      for (const next of entry.next || []) {
        prefetchScheduler?.enqueue(next, 3, `physical:${id}`);
      }
    }
    return bytes;
  })();
  pendingBatches.set(id, {promise, state});
  try { return await promise; } finally { pendingBatches.delete(id); }
}

class PrefetchScheduler {
  constructor() {
    this.queue = new Map();
    this.musicQueue = new Map();
    this.active = 0;
    this.musicActive = false;
    this.pumpScheduled = false;
    this.musicPumpScheduled = false;
    this.musicScheduleGeneration = 0;
    this.musicWaitRequested = false;
    this.sceneKey = '';
    this.sceneMusic = [];
    this.timelineMusic = null;
    this.timelinePosition = '';
  }
  enqueue(id, priority, sceneKey = '') {
    if (!id || batchCache.has(id)) return;
    const old = this.queue.get(id);
    if (!old || priority < old.priority)
      this.queue.set(id, {priority, sceneKey});
    this.schedule();
  }
  enqueueMusic(key, priority, sceneKey = '', source = 'scene') {
    if (!key || api.audio.hasMusic(key)) return false;
    const old = this.musicQueue.get(key);
    if (!old || priority < old.priority || source === 'timeline')
      this.musicQueue.set(key, {priority, sceneKey, source});
    // A decoder job cannot start until its encoded pack is in RAM. Promote
    // that prerequisite explicitly instead of relying on its incidental
    // position among a destination's graphics and script packs.
    const batch = api.manifest?.assets[key]?.batch;
    if (batch) this.enqueue(batch, priority <= 1 ? 0 : 1, sceneKey);
    this.schedule();
    return true;
  }
  schedule() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => { this.pumpScheduled = false; this.pump(); }, 0);
  }
  pump() {
    // Required reads own the network/CPU budget. Do not begin more background
    // work while Asyncify is waiting for an asset needed by the current frame.
    if (blockingLoads) return;
    const constrained = navigator.connection?.saveData
      || /(^|-)2g$/.test(navigator.connection?.effectiveType || '');
    const concurrency = constrained ? 1 : SPECULATIVE_CONCURRENCY;
    while (this.active < concurrency && this.queue.size) {
      const [id] = [...this.queue].sort((a, b) => a[1].priority - b[1].priority)[0];
      this.queue.delete(id);
      if (batchCache.has(id) || pendingBatches.has(id)) continue;
      this.active++;
      fetchBatch(id, true).catch(error => console.warn('Prefetch failed', id, error))
        .finally(() => { this.active--; this.schedule(); });
    }
    this.scheduleMusic();
  }
  scheduleMusic(urgent = this.musicWaitRequested) {
    if (this.musicActive || !this.musicQueue.size) return;
    if (this.musicPumpScheduled && !urgent) return;
    this.musicPumpScheduled = true;
    const generation = ++this.musicScheduleGeneration;
    const run = () => {
      if (generation !== this.musicScheduleGeneration) return;
      this.musicPumpScheduled = false;
      this.pumpMusic();
    };
    // Browser audio decoding is asynchronous, but handing a multi-megabyte
    // Opus stream to the decoder still creates buffers on the page thread.
    // Begin one track at a time during an idle slice, well before a transition.
    // Normal preparation yields to rendering. A dialogue wait explicitly
    // promotes one job with a timer, so a busy animation cannot starve it and
    // speculative decodes do not run throughout animation sequences.
    if (urgent) setTimeout(run, 0);
    else if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
    else setTimeout(run, 50);
  }
  pumpMusic() {
    if (this.musicActive || blockingLoads) return;
    let candidate;
    for (const item of [...this.musicQueue].sort((a, b) => a[1].priority - b[1].priority)) {
      const [key] = item;
      if (api.audio.hasMusic(key)) {
        this.musicQueue.delete(key);
        continue;
      }
      const entry = api.manifest.assets[key];
      if (entry && batchCache.has(entry.batch)) {
        candidate = item;
        break;
      }
    }
    if (!candidate) return;
    const [key] = candidate;
    this.musicQueue.delete(key);
    const bytes = api.cachedAsset(key);
    if (!bytes) {
      this.enqueueMusic(key, candidate[1].priority, candidate[1].sceneKey);
      return;
    }
    this.musicActive = true;
    // One guaranteed decode per dialogue wait. Further speculative work goes
    // back to idle scheduling unless another wait statement is presented.
    this.musicWaitRequested = false;
    api.audio.warmMusic(key, bytes)
      .catch(error => console.warn('Music preparation failed', key, error))
      .finally(() => {
        this.musicActive = false;
        this.schedule();
      });
  }
  applyMusicProtection() {
    api.audio.protectMusic([
      ...(this.timelineMusic ? [this.timelineMusic] : []),
      ...this.sceneMusic,
    ]);
  }
  scriptProgress(sceneKey, offset) {
    const position = `${sceneKey}|${offset}`;
    if (position === this.timelinePosition) return;
    this.timelinePosition = position;
    const music = nextTimelineMusic(api.manifest.musicTimelines?.[sceneKey], Number(offset));
    if (music === this.timelineMusic) return;
    for (const [key, job] of this.musicQueue)
      if (job.source === 'timeline' && key !== music) this.musicQueue.delete(key);
    this.timelineMusic = music;
    this.applyMusicProtection();
    if (!music) return;
    // Branch hooks run before the following transition/image statements. A
    // zero-delay task lets all immediately following branch checks replace the
    // prediction first, then starts just the final resolved cue early enough
    // to keep decodeAudioData off the eventual BGM opcode.
    if (this.enqueueMusic(music, 0, this.sceneKey || sceneKey, 'timeline')) {
      this.musicWaitRequested = true;
      this.scheduleMusic(true);
    }
  }
  playerWait(sceneKey = null, offset = null) {
    if (sceneKey && Number.isFinite(Number(offset))) this.scriptProgress(sceneKey, Number(offset));
    if (!this.musicQueue.size) return;
    this.musicWaitRequested = true;
    this.scheduleMusic(true);
  }
  activate(key) {
    if (!api.manifest) return;
    if (this.sceneKey && this.sceneKey !== key) {
      // Top-level scene hooks are explicit now, so queued work owned only by
      // the departed scene can be pruned safely. Keep decoded and in-flight
      // batches: they may still be useful for backtracking and are shared if
      // the new context requests them.
      for (const [id, job] of this.queue)
        if (job.sceneKey !== key) this.queue.delete(id);
      for (const [music, job] of this.musicQueue)
        if (job.sceneKey !== key) this.musicQueue.delete(music);
    }
    this.sceneKey = key;
    this.timelinePosition = '';
    this.timelineMusic = null;
    const context = api.manifest.sceneContexts?.[key];
    if (context) {
      this.protect(key, context);
      // Interleave the active scene and every direct destination by depth.
      // This prevents a large current script from delaying all adjacent
      // scenes, while still preparing its earliest literal assets first.
      const sets = [context.current || [], ...(context.next || []).map(group => group.batches || [])];
      const depth = Math.max(0, ...sets.map(batches => batches.length));
      for (let index = 0; index < depth; index++)
        for (const batches of sets)
          if (batches[index]) this.enqueue(batches[index], index ? 1 : 0, key);
      // Save-Data still prepares reachable scenes, because that is what keeps
      // a slow connection from stalling on every move. It omits speculative
      // voices and uses one request at a time instead of disabling prefetch.
      if (!navigator.connection?.saveData) {
        for (const id of context.voices || []) this.enqueue(id, 2, key);
        for (const group of context.next || [])
          for (const id of group.voices || []) this.enqueue(id, 3, key);
      }
      // Full-track Web Audio decodes use tens of MiB each. Keep preparation
      // focused on primary choices and pin the highest-confidence working set;
      // decoding broad fallbacks here used to evict the real destination BGM
      // before it was needed and added decoder work during ordinary play.
      const primaryMusic = [
        ...(context.music || []).slice(0, 1),
        ...(context.next || []).flatMap(group => (group.music || []).slice(0, 1)),
      ];
      const focusedMusic = [...new Set(primaryMusic)].slice(0, 2);
      this.sceneMusic = focusedMusic;
      this.applyMusicProtection();
      focusedMusic.forEach((music, index) =>
        this.enqueueMusic(music, index ? 1 : 0, key));
    } else {
      protectedBatches = new Set(residentBatches);
      this.sceneMusic = [];
      this.applyMusicProtection();
      for (const id of api.manifest.prefetch?.[key] || []) this.enqueue(id, 1, key);
    }
    this.scriptProgress(key, 0);
  }
  protect(key, context) {
    const groups = context.next || [];
    const candidates = [api.manifest.assets[key]?.batch];
    // Protect each target script pack before a large current scene can consume
    // the full budget, then the active scene, then deeper destination assets.
    for (const group of groups) candidates.push(group.batches?.[0]);
    candidates.push(...(context.current || []));
    const depth = Math.max(0, ...groups.map(group => (group.batches || []).length));
    for (let index = 1; index < depth; index++)
      for (const group of groups) candidates.push(group.batches?.[index]);
    const next = new Set(residentBatches);
    let bytes = [...residentBatches].reduce((total, id) =>
      total + (api.manifest.batches[id]?.size || 0), 0);
    const budget = Math.floor(MAX_CACHE_BYTES * 0.85);
    for (const id of candidates) {
      if (!id || next.has(id)) continue;
      const size = api.manifest.batches[id]?.size || 0;
      if (size && bytes + size <= budget) {
        next.add(id);
        bytes += size;
      }
    }
    protectedBatches = next;
  }
  activateHotspot(sceneKey, tableName, offset) {
    const table = String(tableName || '').replaceAll('\\', '/').toUpperCase();
    let groups = api.manifest.hotspotContexts?.[`${sceneKey}|${offset}`]
      || api.manifest.hotspotContexts?.[`${sceneKey}|${table}|${offset}`];
    if (!groups) {
      // A6 work can occur inside a returning helper. Queue that helper's
      // conservative outgoing set without replacing/pruning the top-level
      // scene context.
      groups = api.manifest.sceneContexts?.[sceneKey]?.next;
    }
    if (!groups) return;
    const owner = this.sceneKey || sceneKey;
    // Rank all destinations' primary choices before any flag-dependent
    // fallback belonging to a single destination.
    const targetMusic = [
      ...groups.flatMap(group => (group.music || []).slice(0, 1)),
      ...groups.flatMap(group => (group.music || []).slice(1, 2)),
    ];
    const focusedMusic = [...new Set(targetMusic)].slice(0, 2);
    // Once an A6 point-and-click table identifies a smaller set of reachable
    // branches, it is a stronger prediction than the whole scene graph.
    this.sceneMusic = focusedMusic;
    this.applyMusicProtection();
    for (const group of groups) {
      for (const id of group.batches || []) this.enqueue(id, group.priority ?? 1, owner);
      for (const id of group.voices || []) this.enqueue(id, 2, owner);
    }
    for (const music of focusedMusic) this.enqueueMusic(music, 0, owner);
    // Loading the active A6 table means the point-and-click choices are being
    // made available. Like a dialogue wait, this is a useful player-decision
    // window and should guarantee the highest-ranked decode without requiring
    // a hover or click first.
    this.playerWait();
  }
  promoteForAsset(key) {
    const entry = api.manifest?.assets[key];
    if (!entry) return;
    this.enqueue(entry.batch, 0, this.sceneKey);
    if (key.startsWith('MUSIC.ARC/')) this.enqueueMusic(key, 0, this.sceneKey);
    for (const id of api.manifest.dependencies?.[key] || []) this.enqueue(id, 0, this.sceneKey);
  }
  hover(sceneKey, tableOffset, segment) {
    const key = `${sceneKey}|${tableOffset}|${segment}`;
    const groups = api.manifest.hotspotContexts?.[key]
      || api.manifest.hotspotContexts?.[`${sceneKey}|${tableOffset}`]
      || api.manifest.sceneContexts?.[sceneKey]?.next || [];
    const owner = this.sceneKey || sceneKey;
    for (const group of groups) {
      // This only raises jobs that scene entry already queued; it is never the
      // prerequisite for discovering or beginning a point-and-click edge.
      for (const id of group.batches || []) this.enqueue(id, group.priority ?? 0, owner);
    }
  }
  activateSavedScenes(keys) {
    const sets = [];
    for (const key of keys) {
      const own = api.manifest.assets[key]?.batch;
      const current = api.manifest.sceneContexts?.[key]?.current || [];
      if (own) sets.push([own, ...current.filter(id => id !== own)]);
      for (const music of (api.manifest.sceneContexts?.[key]?.music || []).slice(0, 1))
        this.enqueueMusic(music, 1, this.sceneKey || 'reflector');
    }
    const depth = Math.max(0, ...sets.map(batches => batches.length));
    const owner = this.sceneKey || 'reflector';
    for (let index = 0; index < depth; index++)
      for (const batches of sets)
        if (batches[index]) this.enqueue(batches[index], index ? 1 : 0, owner);
  }
}

prefetchScheduler = new PrefetchScheduler();

const api = {
  manifest: null,
  sceneLookup: new Map(),
  module: null,
  cursor: {x: 320, y: 200, id: 0, visible: true},
  cursors: new Map(),
  nextCursor: 1,
  downloads: [],
  rawPointer: false,
  rawUpdates: false,
  absolutePointer: false,
  cursorActive: false,
  touchActive: false,
  capture() { renderer.capture(); },
  createCursor(bytes, width, height, hx, hy) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
    const id = this.nextCursor++;
    this.cursors.set(id, {canvas, hx, hy, url: canvas.toDataURL('image/png')});
    return id;
  },
  setCursor(id) { this.cursor.id = id; updateCursorMode(); },
  freeCursor(id) { this.cursors.delete(id); updateCursorMode(); },
  showCursor(visible) { this.cursor.visible = visible; updateCursorMode(); },
  warp(x, y) { this.cursor.x = Math.min(639, Math.max(0, x)); this.cursor.y = Math.min(399, Math.max(0, y)); },
  resolveSceneKey(name) {
    const normalized = String(name || '').replaceAll('\\', '/').toUpperCase();
    if (this.manifest?.assets[normalized]) return normalized;
    return this.sceneLookup.get(normalized)
      || this.sceneLookup.get(normalized.split('/').pop())
      || normalized;
  },
  sceneEnter(name) {
    const key = this.resolveSceneKey(name);
    prefetchScheduler.activate(key);
  },
  scriptProgress(name, offset) {
    prefetchScheduler.scriptProgress(this.resolveSceneKey(name), Number(offset));
  },
  playerWait(name, offset) {
    prefetchScheduler.playerWait(this.resolveSceneKey(name), Number(offset));
  },
  reflectorOpen(slot) {
    if (!this.module || !Number.isInteger(slot) || slot < 1 || slot > 3) return;
    const scenes = [];
    for (let jewel = 1; jewel <= 8; jewel++) {
      try {
        const bytes = this.module.FS.readFile(`/saves/FLAG${slot}${jewel}`).subarray(0, 128);
        const end = bytes.indexOf(0);
        if (end <= 0) continue;
        const name = String.fromCharCode(...bytes.subarray(0, end));
        if (/^FLAGINI\.MES$/i.test(name)) continue;
        const key = this.resolveSceneKey(name);
        if (this.manifest.assets[key] && !scenes.includes(key)) scenes.push(key);
      } catch {}
    }
    prefetchScheduler.activateSavedScenes(scenes);
  },
  hotspotTableLoaded(scene, name, offset) {
    const key = this.resolveSceneKey(scene);
    prefetchScheduler.activateHotspot(key, name, offset);
  },
  hotspotHover(scene, offset, id) {
    const key = this.resolveSceneKey(scene);
    prefetchScheduler.hover(key, offset, id);
  },
  setting(index, advance) {
    const key = ['pointer', 'speed', 'scaling'][index];
    if (advance) {
      if (index === 0) preferences.pointer = 1 - preferences.pointer;
      if (index === 1) preferences.speed = preferences.speed >= 400 ? 25 : preferences.speed + 25;
      if (index === 2) preferences.scaling = (preferences.scaling + 1) % 4;
      try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch {}
      resize();
      updateCursorMode();
    }
    return preferences[key];
  },
  async asset(key) {
    const entry = this.manifest.assets[key];
    if (!entry) return null;
    const voice = key.startsWith('VOICE_');
    if (!voice) prefetchScheduler.promoteForAsset(key);
    const ownPromise = fetchBatch(entry.batch, false, !voice);
    const own = await ownPromise;
    if (entry.offset < 0 || entry.size < 0 || entry.offset + entry.size > own.length)
      throw new Error(`Invalid asset slice: ${key}`);
    // A copy is intentional: decoded engine data stays valid when its JS pack is evicted.
    return own.slice(entry.offset, entry.offset + entry.size);
  },
  async playVoice(id, name) {
    this.audio.stop(id);
    const token = this.audio.channels[id].token;
    let key = name.replaceAll('\\', '/').toUpperCase();
    if (!this.manifest.assets[key] && key.endsWith('.WAV')) key = `${key.slice(0, -4)}.OGG`;
    const bytes = await this.asset(key);
    if (!bytes || token !== this.audio.channels[id].token) return;
    await this.audio.play(id, name, bytes, false);
  },
  cachedAsset(key) {
    const entry = this.manifest.assets[key];
    if (!entry) return null;
    // This answers whether this asset is usable now, not whether an entire
    // scene context is resident. Missing scene-adjacent packs preload in the
    // background and only the exact asset later requested may block the VM.
    if (!batchCache.has(entry.batch)) return null;
    const own = batchCache.get(entry.batch);
    return own.slice(entry.offset, entry.offset + entry.size);
  },
  saveFiles() {
    if (!this.module) return {};
    const FS = this.module.FS;
    return Object.fromEntries(FS.readdir('/saves').filter(name => /^FLAG\d{2}$/.test(name))
      .map(name => [name, FS.readFile(`/saves/${name}`)]));
  },
  async exportSaves() {
    const bytes = encodeSaveZip(this.saveFiles());
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const filename = 'WebYUNO_saves_' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' +
      pad(now.getDate()) + '-' + pad(now.getHours()) + '-' + pad(now.getMinutes()) + '.zip';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({suggestedName: filename,
          types: [{description: 'Web YU-NO saves', accept: {'application/zip': ['.zip']}}]});
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (error.name !== 'NotAllowedError' && error.name !== 'SecurityError') throw error;
      }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], {type: 'application/zip'}));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  },
  async importSaves() {
    let chosen;
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({multiple: false,
          types: [{description: 'Web YU-NO saves', accept: {'application/zip': ['.zip']}}]});
        chosen = await handles[0]?.getFile();
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (error.name !== 'NotAllowedError' && error.name !== 'SecurityError') throw error;
      }
    }
    if (!chosen) {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.zip,application/zip'; input.hidden = true;
      document.body.appendChild(input);
      try {
        chosen = await new Promise(resolve => {
          input.onchange = () => resolve(input.files?.[0] || null);
          input.oncancel = () => resolve(null);
          input.click();
        });
      } finally {
        input.remove();
      }
    }
    if (!chosen) return;
    const files = decodeSaveZip(new Uint8Array(await chosen.arrayBuffer()));
    await store.save(files);
    location.reload();
  },
  async syncSaves() {
    try { await store.save(this.saveFiles()); }
    catch (error) { failure(error); }
  },
  async restart() { await this.syncSaves(); location.reload(); },
};
api.audio = new BrowserAudio();
// Also useful for local diagnostics; no game assets or saves are sent elsewhere.
window.webYuno = api;

function updateCursorMode() {
  // Touch always operates as a virtual touchpad. Even when the saved mouse
  // preference is System, render the game's own cursor while touch is active;
  // there is no useful native hover cursor on a touchscreen and compatibility
  // mouse events must not switch this back implicitly.
  const system = preferences.pointer === 1 && !api.touchActive;
  api.absolutePointer = system;
  if (system && document.pointerLockElement === engine) document.exitPointerLock();
  const sprite = api.cursors.get(api.cursor.id);
  if (system && api.cursor.visible && sprite)
    engine.style.cursor = `url("${sprite.url}") ${sprite.hx} ${sprite.hy}, auto`;
  else
    engine.style.cursor = 'none';
}

function restoreSystemCursor() {
  if (preferences.pointer !== 1) return;
  // Re-entering a Firefox tab/canvas can leave its native cursor on the
  // outside-page cursor until the CSS value changes. Force a value change,
  // then restore the current game frame even when the game has not animated it.
  engine.style.cursor = 'none';
  requestAnimationFrame(updateCursorMode);
}
engine.addEventListener('mouseenter', restoreSystemCursor);
window.addEventListener('focus', restoreSystemCursor);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) restoreSystemCursor();
});

function resize() {
  if (!renderer) return;
  const stage = $('stage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const fit = fitViewport(Math.floor(stage.width * dpr), Math.floor(stage.height * dpr), preferences.scaling);
  $('viewport').style.width = `${fit.width / dpr}px`;
  $('viewport').style.height = `${fit.height / dpr}px`;
  $('display').width = fit.width; $('display').height = fit.height;
  renderer.invalidate();
}
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);

async function capturePointer() {
  if (!started) return;
  if (preferences.pointer === 1) {
    api.absolutePointer = true;
    api.cursorActive = true;
    engine.focus();
    return;
  }
  try {
    const request = engine.requestPointerLock({unadjustedMovement: true});
    if (request?.then) await request;
    api.rawPointer = true;
    engine.focus();
  } catch (rawError) {
    try {
      const fallback = engine.requestPointerLock();
      if (fallback?.then) await fallback;
      api.rawPointer = false;
      engine.focus();
    } catch {
      status('Pointer capture was declined. Click the game to try again.');
    }
  }
}
function resumeAudio(create = false) {
  if (create && api.module && !api.module.SDL2?.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      api.module.SDL2 ||= {};
      api.module.SDL2.audioContext = new AudioContextClass();
    }
  }
  const context = api.module?.SDL2?.audioContext;
  if (context?.state === 'suspended') context.resume().catch(console.warn);
}
engine.addEventListener('mousedown', event => {
  if (!event.isTrusted && !event.webTouch) return;
  if (!event.webTouch && isTouchCompatibilityMouse(event)) {
    event.preventDefault(); event.stopImmediatePropagation();
    return;
  }
  if (!ready) return;
  if (!started) startGame();
  resumeAudio();
  if (event.webTouch) return;
  if (api.touchActive) {
    api.touchActive = false;
    updateCursorMode();
  }
  if (preferences.pointer === 1) {
    api.absolutePointer = true;
    api.cursorActive = true;
    applyAbsolutePointer(event);
  } else if (document.pointerLockElement !== engine) {
    event.stopImmediatePropagation(); event.preventDefault(); capturePointer();
  }
}, true);
engine.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('pointerlockchange', () => {
  api.rawUpdates = false;
  if (document.pointerLockElement === engine) {
    api.cursorActive = true;
    engine.focus();
    resumeAudio();
  }
});
function applyAbsolutePointer(event) {
  const rect = engine.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  api.warp((event.clientX - rect.left) * 640 / rect.width,
    (event.clientY - rect.top) * 400 / rect.height);
}
function applyPointerMovement(event) {
  const factor = preferences.speed / 100;
  const coalesced = event.getCoalescedEvents?.() || [];
  const samples = coalesced.length ? coalesced : [event];
  let dx = 0, dy = 0;
  for (const sample of samples) {
    dx += sample.movementX || sample.mozMovementX || 0;
    dy += sample.movementY || sample.mozMovementY || 0;
  }
  if (!dx && !dy) return false;
  api.warp(api.cursor.x + dx * factor, api.cursor.y + dy * factor);
  return true;
}
// Firefox 148+ exposes high-frequency pointer updates. Firefox 140--147
// emitted zero deltas for this event, so mousemove remains the fallback.
document.addEventListener('pointerrawupdate', event => {
  if (preferences.pointer === 1 || document.pointerLockElement !== engine) return;
  if (applyPointerMovement(event)) api.rawUpdates = true;
});
document.addEventListener('mousemove', event => {
  if (isTouchCompatibilityMouse(event)) return;
  if (api.touchActive) {
    api.touchActive = false;
    updateCursorMode();
  }
  if (preferences.pointer === 1) {
    if (event.target === engine) applyAbsolutePointer(event);
    return;
  }
  if (document.pointerLockElement !== engine || api.rawUpdates) return;
  applyPointerMovement(event);
});

const touch = {points: new Map(), primary: null, moved: false, held: false,
  multi: false, three: false, control: false, holdTimer: 0};
const touchSurface = $('stage');
let suppressTouchMouseUntil = 0;
function isTouchCompatibilityMouse(event) {
  if (event.webTouch) return false;
  return touch.points.size > 0 || performance.now() < suppressTouchMouseUntil ||
    event.sourceCapabilities?.firesTouchEvents === true;
}
function suppressTouchCompatibilityMouse(event) {
  if (!isTouchCompatibilityMouse(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
// Pointer Events drive the virtual touchpad. Block the parallel Touch Events
// path before Emscripten/SDL can translate it into direct canvas input, and
// block the compatibility mouse sequence browsers may synthesize afterward.
for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
  touchSurface.addEventListener(type, event => {
    event.preventDefault(); event.stopImmediatePropagation();
  }, {capture: true, passive: false});
for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'])
  window.addEventListener(type, suppressTouchCompatibilityMouse,
    {capture: true, passive: false});
function touchControl(down) {
  if (touch.control === down) return;
  touch.control = down;
  engine.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true,
    ctrlKey: down
  }));
}
function gameButton(button) {
  const options = {bubbles: true, cancelable: true, button, buttons: 1 << button,
    clientX: engine.getBoundingClientRect().left, clientY: engine.getBoundingClientRect().top};
  const down = new MouseEvent('mousedown', options);
  Object.defineProperty(down, 'webTouch', {value: true});
  const up = new MouseEvent('mouseup', {...options, buttons: 0});
  Object.defineProperty(up, 'webTouch', {value: true});
  engine.dispatchEvent(down);
  setTimeout(() => engine.dispatchEvent(up), 0);
}
let mobileFullscreenRequested = false;
function requestMobileFullscreen() {
  if (!mobileOrTablet || mobileFullscreenRequested || document.fullscreenElement) return;
  mobileFullscreenRequested = true;
  document.documentElement.requestFullscreen?.().catch(() => { mobileFullscreenRequested = false; });
}
touchSurface.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  event.preventDefault(); event.stopImmediatePropagation();
  suppressTouchMouseUntil = performance.now() + 1000;
  requestMobileFullscreen();
  resumeAudio(); api.cursorActive = true;
  if (!api.touchActive) {
    api.touchActive = true;
    updateCursorMode();
  }
  if (!touch.points.size) {
    touch.multi = false;
    touch.primary = event.pointerId; touch.moved = false;
    touch.held = false; touch.three = false;
  } else {
    touch.multi = true;
    clearTimeout(touch.holdTimer);
  }
  touch.points.set(event.pointerId, {
    x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
  });
  touchSurface.setPointerCapture?.(event.pointerId);
  if (touch.points.size >= 3) {
    touch.three = true;
    touchControl(true);
  }
  if (touch.points.size === 1) {
    touch.holdTimer = setTimeout(() => {
      if (touch.points.size === 1 && touch.points.has(event.pointerId) && !touch.moved) {
        touch.held = true; gameButton(2);
      }
    }, 550);
  }
}, {capture: true, passive: false});
touchSurface.addEventListener('pointermove', event => {
  if (event.pointerType !== 'touch' || !touch.points.has(event.pointerId)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const point = touch.points.get(event.pointerId);
  if (Math.hypot(event.clientX - point.startX, event.clientY - point.startY) > 8) {
    touch.moved = true; clearTimeout(touch.holdTimer);
  }
  if (event.pointerId !== touch.primary || touch.multi) {
    point.x = event.clientX; point.y = event.clientY;
    return;
  }
  const rect = engine.getBoundingClientRect();
  const factor = preferences.speed / 100;
  api.warp(api.cursor.x + (event.clientX - point.x) * 640 / rect.width * factor,
    api.cursor.y + (event.clientY - point.y) * 400 / rect.height * factor);
  point.x = event.clientX; point.y = event.clientY;
}, {capture: true, passive: false});
function finishTouch(event) {
  if (!touch.points.has(event.pointerId)) return;
  event.preventDefault(); event.stopImmediatePropagation(); clearTimeout(touch.holdTimer);
  suppressTouchMouseUntil = performance.now() + 1000;
  touch.points.delete(event.pointerId);
  if (touch.points.size < 3) touchControl(false);
  if (touch.points.size) return;
  if (!touch.moved && !touch.held && !touch.three) {
    gameButton(touch.multi ? 2 : 0);
  }
  touch.primary = null;
}
touchSurface.addEventListener('pointerup', finishTouch, {capture: true, passive: false});
touchSurface.addEventListener('pointercancel', event => {
  if (!touch.points.has(event.pointerId)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  suppressTouchMouseUntil = performance.now() + 1000;
  clearTimeout(touch.holdTimer); touch.points.delete(event.pointerId);
  if (touch.points.size < 3) touchControl(false);
  if (!touch.points.size) touch.primary = null;
}, {capture: true, passive: false});
document.addEventListener('keydown', event => {
  if (ready && !started) {
    startGame();
    resumeAudio();
  } else if (started) {
    resumeAudio();
  }
  if (event.key === 'F11') { event.preventDefault(); event.stopImmediatePropagation(); toggleFullscreen(); }
}, true);

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) { status(error.message); }
}
function startGame() {
  if (started) return;
  started = true;
  // Construct the context while this call still belongs to the click/key
  // gesture; SDL2 will adopt Module.SDL2.audioContext during audio init.
  resumeAudio(true);
  try { api.module.callMain(['--game', 'yuno-eng', '--font', '/game/msgothic.ttc', '/game']); }
  catch (error) { if (error !== 'unwind') failure(error); }
}

async function fetchRuntime() {
  const entry = {url: `yuno.wasm.gz?v=${release}`, encoding: 'gzip'};
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const operation = Symbol(entry.url);
    const warning = setTimeout(() => {
      slowDownloads.add(operation); updateDownloadIndicator();
    }, DOWNLOAD_WARNING_MS);
    const controller = new AbortController();
    let stall;
    const resetStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new DOMException(
        `Download stalled: ${entry.url}`, 'TimeoutError')), DOWNLOAD_STALL_MS);
    };
    resetStall();
    try {
      const response = await fetch(entry.url, {signal: controller.signal,
        cache: attempt === 1 ? 'default' : 'reload'});
      const bytes = await decodedResponse(response, true, resetStall);
      if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 ||
          bytes[2] !== 115 || bytes[3] !== 109)
        throw new Error('Invalid WebAssembly executable.');
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS)
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 3000)));
    } finally {
      clearTimeout(stall); clearTimeout(warning);
      slowDownloads.delete(operation); updateDownloadIndicator();
    }
  }
  throw new Error(`Executable download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${lastError?.message || lastError}`);
}

async function acquireSaveLock() {
  if (!navigator.locks) return;
  await new Promise((resolve, reject) => {
    navigator.locks.request(store.key, {ifAvailable: true}, lock => {
      if (!lock) { reject(new Error('YU-NO is already open in another tab. Close it, then reload this page.')); return; }
      resolve();
      return new Promise(() => {}); // released automatically when this page closes
    }).catch(reject);
  });
}

async function prepare() {
  if (!window.isSecureContext) throw new Error('Open Web YU-NO over HTTPS or localhost.');
  renderer = new Renderer($('display'), engine);
  resize();
  const presentationInterval = 1000 / 60;
  let previousAnimationTimestamp = 0;
  let presentationBudget = presentationInterval;
  const animate = timestamp => {
    requestAnimationFrame(animate);
    if (previousAnimationTimestamp) {
      // Accumulate actual refresh time instead of an absolute fractional
      // deadline. Firefox's reduced timestamp precision can otherwise leave a
      // nominal 60Hz frame just early, skip it, and retain that phase error.
      presentationBudget += Math.min(timestamp - previousAnimationTimestamp,
        presentationInterval * 4);
    }
    previousAnimationTimestamp = timestamp;
    if (presentationBudget < presentationInterval) return;
    presentationBudget = Math.max(0, presentationBudget - presentationInterval);
    renderer.draw(preferences.scaling, api.cursor, api.cursors.get(api.cursor.id),
      api.touchActive || (preferences.pointer === 0 && api.cursorActive));
  };
  requestAnimationFrame(animate);
  await acquireSaveLock();
  const moduleOptions = {canvas: engine, noInitialRun: true, webYuno: api,
      locateFile: path => `${path}?v=${release}`,
      print: text => console.log(text), printErr: text => console.warn(text),
      onAbort: reason => failure(new Error(String(reason))),
      onExit: () => { api.syncSaves(); document.exitPointerLock(); status('Game closed. Reload this page to play again.'); },
    };
  const [module, storedFiles, manifestBytes] = await Promise.all([
    fetchRuntime().then(wasmBinary => createYuno({...moduleOptions, wasmBinary})),
    store.open(),
    fetch(`manifest.json.gz?v=${release}`).then(response => decodedResponse(response, true)),
  ]);
  api.module = module;
  // Firefox intentionally does not expose whether its Linux backend is X11
  // or Wayland (the UA normally says X11 for both), so use the conservative
  // path for Firefox on Linux as a whole.
  api.manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (api.manifest.version !== 3) throw new Error('Unsupported asset manifest. Rebuild the static site.');
  residentBatches = new Set(api.manifest.residentBatches || []);
  // Engine scene notifications normally contain a basename. Resolve them in
  // O(1), and only accept a basename when it identifies exactly one script.
  // This avoids scanning all 30k+ assets on every A6 hotspot change.
  const sceneNames = new Map();
  for (const key of Object.keys(api.manifest.assets)) {
    if (!key.endsWith('.MES')) continue;
    const normalized = key.replaceAll('\\', '/').toUpperCase();
    api.sceneLookup.set(normalized, key);
    const basename = normalized.split('/').pop();
    sceneNames.set(basename, sceneNames.has(basename) ? null : key);
  }
  for (const [basename, key] of sceneNames) if (key) api.sceneLookup.set(basename, key);
  // Speculative packs are decoded and verified off the page thread so their
  // CPU/memory work cannot compete directly with the WebAssembly frame loop.
  startPrefetchWorker();
  await persistentAssets.prepare(Object.values(api.manifest.batches));
  let files = storedFiles;
  const signature = files.FLAG00 && new TextDecoder('ascii').decode(files.FLAG00.slice(0, 12));
  let installedSeed = '';
  try { installedSeed = localStorage.getItem(saveSeedKey) || ''; } catch {}
  if (signature !== 'FLAGINI.MES\0' || installedSeed !== api.manifest.saveSeedId) {
    files = Object.fromEntries(await Promise.all(Object.entries(api.manifest.cleanSaves)
      .map(async ([name, entry]) => [name, await fetchEntry(entry)])));
    await store.save(files);
    try { localStorage.setItem(saveSeedKey, api.manifest.saveSeedId); } catch {}
  }
  module.FS.mkdir('/game'); module.FS.mkdir('/saves');
  for (const [name, bytes] of Object.entries(files)) module.FS.writeFile(`/saves/${name}`, bytes);
  // This is the only visible loading phase: runtime/background packs never alter the bar.
  const initial = [
    ...Object.entries(api.manifest.bootstrap).map(([name, entry]) => async () => {
      module.FS.writeFile(`/game/${name}`, await fetchEntry(entry));
    }),
    ...api.manifest.bootstrapBatches.map(id => async () => { await fetchBatch(id, true); }),
  ];
  const initialCount = initial.length;
  let completed = 0;
  const workers = Array.from({length: Math.min(4, initial.length)}, async () => {
    while (initial.length) {
      const load = initial.shift();
      await load();
      completed++;
      const progress = Math.round(completed / initialCount * 100);
      $('loading').setAttribute('aria-valuenow', progress);
      $('loading-progress').style.width = `${progress}%`;
    }
  });
  await Promise.all(workers);
  resumeAudio(true);
  api.audio.initialize(module);
  await api.audio.warmEffects(api);
  module.FS.chdir('/game');
  $('loading').hidden = true;
  ready = true;
  updateCursorMode();
  // A suspended AudioContext does not advance its playback clock. Starting
  // now renders the initial color/monochrome choice immediately; the first
  // gesture only resumes audio and captures the pointer.
  startGame();
}
prepare().catch(failure);
