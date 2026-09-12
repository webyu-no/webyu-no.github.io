const oggCrcTable = Array.from({length: 256}, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++)
    value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

function oggPages(bytes) {
  const pages = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 27 > bytes.length || bytes[offset] !== 79 || bytes[offset + 1] !== 103 ||
        bytes[offset + 2] !== 103 || bytes[offset + 3] !== 83 || bytes[offset + 4] !== 0)
      throw new Error('Invalid shared-header Ogg stream.');
    const segments = bytes[offset + 26];
    const tableEnd = offset + 27 + segments;
    if (tableEnd > bytes.length) throw new Error('Truncated Ogg lacing table.');
    let end = tableEnd;
    for (let i = offset + 27; i < tableEnd; i++) end += bytes[i];
    if (end > bytes.length) throw new Error('Truncated Ogg page.');
    pages.push([offset, end]);
    offset = end;
  }
  return pages;
}

function patchOggHeader(template, serial) {
  const bytes = template.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [start, end] of oggPages(bytes)) {
    view.setUint32(start + 14, serial, true);
    view.setUint32(start + 22, 0, true);
    let crc = 0;
    for (let offset = start; offset < end; offset++)
      crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) ^ bytes[offset]) & 255]) >>> 0;
    view.setUint32(start + 22, crc, true);
  }
  return bytes;
}

export class BrowserAudio {
  constructor() {
    this.module = null;
    this.master = null;
    this.buffers = new Map();
    this.musicBufferBytes = new Map();
    // AudioBuffer contains decoded float PCM. This holds roughly three normal
    // YU-NO tracks while leaving room for the scene-pack and Wasm heaps.
    this.musicCacheBytes = 0;
    this.musicCacheLimit = 192 * 1024 * 1024;
    // Full decoded tracks are large, so retain only the scene predictor's
    // small high-confidence set in addition to the track that is playing.
    // Without this, lower-ranked speculative decodes can evict the actual
    // destination track just before the player changes locations.
    this.protectedMusic = new Set();
    this.protectedMusicLimit = 2;
    this.vorbisHeaders = [];
    this.loadPauses = 0;
    this.keepAlive = null;
    this.channels = Array.from({length: 6}, () => ({
      source: null, gain: null, playing: false, token: 0,
      gainValue: 1, fadeStart: 0, fadeEnd: 0, fadeFrom: 1, fadeTo: 1,
      fadeRemaining: 0, fadeStop: false, fadeTimer: null, fadeGeneration: 0,
      buffer: null, loop: false,
      loopStart: 0, loopEnd: 0, startedAt: 0, offset: 0, pausedOffset: null,
      cacheKey: null,
    }));
  }

  context() { return this.module?.SDL2?.audioContext || null; }

  initialize(module) {
    this.module = module;
    this.vorbisHeaders = (module.webYuno.manifest.vorbisHeaders || []).map(encoded => {
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });
    if (this.master) return;
    const context = this.context();
    if (!context) throw new Error('Web Audio is unavailable.');
    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);
    // Keep one silent node rendering so a logical game/loading pause does not
    // tear down and recreate the browser's OS audio stream. Recreating that
    // stream resets user-adjusted per-application volume on some Linux mixers.
    if (context.createConstantSource) {
      this.keepAlive = context.createConstantSource();
      this.keepAlive.offset.value = 0;
      this.keepAlive.connect(this.master);
      this.keepAlive.start();
    }
    for (const channel of this.channels) {
      channel.gain = context.createGain();
      channel.gain.gain.value = 1;
      channel.gain.connect(this.master);
    }
  }

  cacheKey(id, name, bytes) {
    if (id < 0 || id > 3) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const first = bytes.length >= 4 ? view.getUint32(0) : 0;
    const last = bytes.length >= 4 ? view.getUint32(bytes.length - 4) : 0;
    const basename = name.replaceAll('\\', '/').split('/').pop().toUpperCase();
    return `${id === 0 ? 'music' : 'effect'}:${basename}:${bytes.length}:${first}:${last}`;
  }

  musicName(name) {
    return name.replaceAll('\\', '/').split('/').pop().toUpperCase();
  }

  musicNameFromCacheKey(key) {
    if (!key.startsWith('music:')) return null;
    const end = key.indexOf(':', 6);
    return end < 0 ? null : key.slice(6, end);
  }

  protectMusic(names) {
    const next = new Set();
    for (const name of names || []) {
      if (!name) continue;
      next.add(this.musicName(name));
      if (next.size >= this.protectedMusicLimit) break;
    }
    this.protectedMusic = next;
    // Dropping a previous scene's protection should immediately return the
    // cache to budget instead of waiting for another decode to finish.
    this.trimMusicCache();
  }

  hasMusic(name) {
    const prefix = `music:${this.musicName(name)}:`;
    return [...this.buffers.keys()].some(key => key.startsWith(prefix));
  }

  cachedMusic(name) {
    const prefix = `music:${this.musicName(name)}:`;
    for (const [key, value] of this.buffers) {
      if (key.startsWith(prefix) && typeof value?.then !== 'function') return [key, value];
    }
    return null;
  }

  touchBuffer(key, value) {
    this.buffers.delete(key);
    this.buffers.set(key, value);
  }

  decodedBufferBytes(buffer) {
    if (Number.isFinite(buffer?.length) && Number.isFinite(buffer?.numberOfChannels))
      return buffer.length * buffer.numberOfChannels * 4;
    if (Number.isFinite(buffer?.duration) && Number.isFinite(buffer?.sampleRate))
      return Math.ceil(buffer.duration * buffer.sampleRate) * (buffer.numberOfChannels || 2) * 4;
    return 0;
  }

  trimMusicCache() {
    while (this.musicCacheBytes > this.musicCacheLimit) {
      const playing = this.channels[0].playing ? this.channels[0].cacheKey : null;
      const oldest = [...this.buffers].find(([key, value]) =>
        key.startsWith('music:') && key !== playing
        && !this.protectedMusic.has(this.musicNameFromCacheKey(key))
        && typeof value?.then !== 'function');
      if (!oldest) break;
      const [key] = oldest;
      this.buffers.delete(key);
      this.musicCacheBytes -= this.musicBufferBytes.get(key) || 0;
      this.musicBufferBytes.delete(key);
    }
  }

  expandVorbis(bytes) {
    if (bytes.length < 5 || bytes[0] !== 87 || bytes[1] !== 86 ||
        bytes[2] !== 79 || bytes[3] !== 82) return bytes;
    const template = this.vorbisHeaders[bytes[4]];
    const tail = bytes.subarray(5);
    if (!template || tail.length < 27 || tail[0] !== 79 || tail[1] !== 103 ||
        tail[2] !== 103 || tail[3] !== 83)
      throw new Error('Invalid shared Vorbis asset.');
    const serial = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(14, true);
    const header = patchOggHeader(template, serial);
    const output = new Uint8Array(header.length + tail.length);
    output.set(header);
    output.set(tail, header.length);
    return output;
  }

  decode(id, name, bytes) {
    const cacheKey = this.cacheKey(id, name, bytes);
    const cached = cacheKey && this.buffers.get(cacheKey);
    if (cached) {
      this.touchBuffer(cacheKey, cached);
      return cached;
    }
    bytes = this.expandVorbis(bytes);
    const encoded = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const pending = this.context().decodeAudioData(encoded).then(buffer => {
      if (cacheKey) {
        this.touchBuffer(cacheKey, buffer);
        if (id === 0 && !this.musicBufferBytes.has(cacheKey)) {
          const size = this.decodedBufferBytes(buffer);
          this.musicBufferBytes.set(cacheKey, size);
          this.musicCacheBytes += size;
          this.trimMusicCache();
        }
      }
      return buffer;
    });
    if (cacheKey) {
      this.buffers.set(cacheKey, pending);
      pending.catch(() => {
        if (this.buffers.get(cacheKey) === pending) this.buffers.delete(cacheKey);
      });
    }
    return pending;
  }

  metadata(id, name) {
    const assets = this.module?.webYuno?.manifest?.assets;
    if (!assets) return null;
    const normalized = name.replaceAll('\\', '/').toUpperCase();
    if (assets[normalized]) return assets[normalized];
    if (id === 0) {
      const basename = normalized.split('/').pop();
      return assets[`MUSIC.ARC/${basename}`] || null;
    }
    return null;
  }

  async warmEffects(api) {
    const names = Object.keys(api.manifest.assets).filter(name =>
      name.startsWith('SFX/') || /^SE\d+\.WAV$/.test(name));
    let cursor = 0;
    const workers = Array.from({length: 8}, async () => {
      while (cursor < names.length) {
        const key = names[cursor++];
        const bytes = api.cachedAsset(key);
        if (bytes) await this.decode(1, key.split('/').pop(), bytes);
      }
    });
    await Promise.all(workers);
  }

  async warmMusic(name, bytes) {
    await this.decode(0, name, bytes);
  }

  setDecodedPlayback(id, name, buffer, loop, cacheKey, token) {
    const channel = this.channels[id];
    if (token !== channel.token) return;
    const metadata = this.metadata(id, name);
    const embeddedLoop = metadata?.loopEnd > metadata?.loopStart;
    channel.buffer = buffer;
    channel.cacheKey = cacheKey;
    // The game routes both ordinary music and short stingers through its BGM
    // channel. The `loop` argument only describes the channel default; RIFF
    // loop metadata distinguishes looping music from one-shot cues such as
    // YUNO_72/YUNO_73. Effects may also carry authored loop regions.
    channel.loop = id === 0 ? embeddedLoop : (loop || embeddedLoop);
    channel.loopStart = embeddedLoop ? metadata.loopStart : 0;
    channel.loopEnd = embeddedLoop ? metadata.loopEnd : (channel.loop ? buffer.duration : 0);
    channel.offset = 0;
    channel.playing = true;
    if (this.loadPauses) channel.pausedOffset = 0;
    else this.startSource(channel);
  }

  playCachedMusic(name, loop, preservePlaying = false, volume = 100) {
    const cached = this.cachedMusic(name);
    if (!cached) return false;
    const [cacheKey, buffer] = cached;
    this.touchBuffer(cacheKey, buffer);
    const channel = this.channels[0];
    // Compare the decoded asset identity rather than script spelling. Scene
    // dispatchers can repeat the same BGM with different path/case spelling.
    // ai5-sdl2 preserves an already-playing copy of the same track even while
    // its mixer gain is changing. In particular, a repeated script-side BGM
    // command must not replace the source or its authored fade.
    if (preservePlaying && channel.playing && channel.cacheKey === cacheKey) return true;
    this.stop(0);
    // Apply the engine's persistent mixer volume only when starting a source.
    // Applying it before the identity check would cancel a fade on a track
    // that standalone ai5-sdl2 leaves alone.
    this.setVolume(0, volume);
    const token = this.channels[0].token;
    this.setDecodedPlayback(0, name, buffer, loop, cacheKey, token);
    return true;
  }

  playbackOffset(channel, now = this.context().currentTime) {
    let offset = channel.offset + Math.max(0, now - channel.startedAt);
    const duration = channel.buffer?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return offset;
    if (!channel.loop) return Math.min(offset, duration);
    const start = channel.loopStart || 0;
    const end = channel.loopEnd > start ? channel.loopEnd : duration;
    if (offset >= end && end > start) offset = start + (offset - start) % (end - start);
    return offset;
  }

  startSource(channel, offset = 0) {
    if (!channel.buffer) return false;
    const duration = channel.buffer.duration;
    if (!channel.loop && Number.isFinite(duration) && offset >= duration) {
      channel.playing = false;
      channel.buffer = null;
      channel.pausedOffset = null;
      return false;
    }
    const source = this.context().createBufferSource();
    source.buffer = channel.buffer;
    source.loop = channel.loop;
    if (channel.loopEnd > channel.loopStart) {
      source.loopStart = channel.loopStart;
      source.loopEnd = channel.loopEnd;
    }
    source.connect(channel.gain);
    channel.source = source;
    channel.offset = Math.max(0, offset);
    channel.startedAt = this.context().currentTime;
    channel.pausedOffset = null;
    source.onended = () => {
      if (channel.source !== source) return;
      if (channel.fadeTimer !== null) clearTimeout(channel.fadeTimer);
      channel.fadeTimer = null;
      channel.fadeGeneration++;
      channel.playing = false;
      channel.fadeEnd = 0;
      channel.fadeRemaining = 0;
      channel.fadeStop = false;
      channel.source = null;
      channel.buffer = null;
      channel.cacheKey = null;
      channel.offset = 0;
      source.disconnect();
    };
    source.start(0, channel.offset);
    return true;
  }

  stop(id) {
    const channel = this.channels[id];
    if (channel.fadeTimer !== null) clearTimeout(channel.fadeTimer);
    channel.fadeTimer = null;
    channel.fadeGeneration++;
    channel.token++;
    channel.playing = false;
    channel.fadeEnd = 0;
    channel.fadeRemaining = 0;
    channel.fadeStop = false;
    channel.buffer = null;
    channel.pausedOffset = null;
    channel.offset = 0;
    channel.cacheKey = null;
    if (!channel.source) return;
    channel.source.onended = null;
    try { channel.source.stop(); } catch {}
    channel.source.disconnect();
    channel.source = null;
  }

  async play(id, name, bytes, loop) {
    this.stop(id);
    const channel = this.channels[id], token = channel.token;
    const cacheKey = this.cacheKey(id, name, bytes);
    const decoded = this.decode(id, name, bytes);
    let buffer;
    if (typeof decoded.then === 'function') {
      let paused = false;
      // Only a new music decode holds its own playback clock. Effects are
      // predecoded and voices/effects must never suspend existing audio.
      if (id === 0) paused = await this.pauseForLoad();
      try { buffer = await decoded; }
      finally { await this.resumeForLoad(paused); }
    } else {
      // Keep predecoded effects synchronous through source.start(). Besides
      // avoiding a microtask of latency, this makes an immediate is-playing
      // query observe the sound that was just started.
      buffer = decoded;
    }
    // BGM loops as a whole when it has no authored loop. Effects are normally
    // one-shot, but a RIFF smpl loop makes them persistent until the game
    // explicitly stops or replaces their channel.
    this.setDecodedPlayback(id, name, buffer, loop, cacheKey, token);
  }

  setVolume(id, percent) {
    const channel = this.channels[id], now = this.context().currentTime;
    // A direct mixer-volume command cancels an active fade without stopping
    // its stream in standalone ai5-sdl2.
    if (channel.fadeStop) this.cancelScheduledStop(id, now);
    const value = percent / 100;
    channel.gain.gain.cancelScheduledValues(now);
    channel.gain.gain.setValueAtTime(value, now);
    channel.gainValue = value;
    channel.fadeStart = 0;
    channel.fadeEnd = 0;
    channel.fadeRemaining = 0;
    channel.fadeStop = false;
    channel.fadeFrom = value;
    channel.fadeTo = value;
  }

  gainAt(channel, now) {
    if (!channel.fadeEnd) return channel.gainValue;
    if (now <= channel.fadeStart) return channel.fadeFrom;
    if (now >= channel.fadeEnd) return channel.fadeTo;
    const progress = (now - channel.fadeStart) / (channel.fadeEnd - channel.fadeStart);
    return channel.fadeFrom + (channel.fadeTo - channel.fadeFrom) * progress;
  }

  cancelScheduledStop(id, now = this.context().currentTime) {
    const channel = this.channels[id];
    if (!channel.fadeStop) return true;
    // Mixer fade completion is driven by the audio clock. If it already
    // elapsed, process the authored stop before the replacing command.
    if (channel.fadeEnd && now >= channel.fadeEnd) {
      this.stop(id);
      return false;
    }
    if (channel.fadeTimer !== null) clearTimeout(channel.fadeTimer);
    channel.fadeTimer = null;
    channel.fadeGeneration++;
    channel.fadeStop = false;
    return true;
  }

  armFadeStop(id) {
    const channel = this.channels[id];
    if (channel.fadeTimer !== null) clearTimeout(channel.fadeTimer);
    const generation = ++channel.fadeGeneration;
    const finish = () => {
      if (!channel.fadeStop || channel.fadeGeneration !== generation) return;
      channel.fadeTimer = null;
      const remaining = channel.fadeEnd - this.context().currentTime;
      if (remaining > 0) {
        channel.fadeTimer = setTimeout(finish, Math.max(1, Math.ceil(remaining * 1000)));
        channel.fadeTimer?.unref?.();
        return;
      }
      this.stop(id);
    };
    const remaining = Math.max(0, channel.fadeEnd - this.context().currentTime);
    channel.fadeTimer = setTimeout(finish, Math.max(1, Math.ceil(remaining * 1000)));
    channel.fadeTimer?.unref?.();
  }

  fade(id, percent, milliseconds, stop) {
    const channel = this.channels[id], context = this.context();
    if (!channel.source) return;
    // Native mixer fades replace one another while the stream keeps playing.
    // The stop is therefore a cancellable mixer action, not a future
    // AudioBufferSourceNode.stop(), which browsers provide no way to unschedule.
    if (channel.fadeStop && !this.cancelScheduledStop(id, context.currentTime)) return;
    if (milliseconds <= 0) {
      this.setVolume(id, percent);
      if (stop) this.stop(id);
      return;
    }
    const now = context.currentTime, end = now + milliseconds / 1000;
    const from = this.gainAt(channel, now), to = percent / 100;
    // Match ai5-sdl2's mixer: explicitly start from the interpolated current
    // gain. AudioParam.value/cancelAndHoldAtTime can expose the scheduled
    // endpoint instead on some browsers, producing an audible initial jump.
    channel.gain.gain.cancelScheduledValues(now);
    channel.gain.gain.setValueAtTime(from, now);
    channel.gain.gain.linearRampToValueAtTime(to, end);
    channel.gainValue = to;
    channel.fadeStart = now;
    channel.fadeEnd = end;
    channel.fadeFrom = from;
    channel.fadeTo = to;
    channel.fadeRemaining = 0;
    channel.fadeStop = stop;
    if (stop) this.armFadeStop(id);
  }

  isPlaying(id) { return this.channels[id].playing; }
  isFading(id) {
    const channel = this.channels[id], now = this.context()?.currentTime || 0;
    if (channel.fadeStop && channel.fadeEnd && now >= channel.fadeEnd) {
      this.stop(id);
      return false;
    }
    return channel.fadeRemaining > 0
      || channel.fadeEnd > now;
  }

  async pauseForLoad() {
    const context = this.context();
    if (!this.master) return false;
    // Nested blocking reads share one logical transport pause.
    if (this.loadPauses) {
      this.loadPauses++;
      return true;
    }
    // Do not claim a user/autoplay suspension that Web YU-NO did not create.
    if (context?.state !== 'running') return false;
    this.loadPauses++;
    const now = context.currentTime;
    for (const channel of this.channels) {
      if (!channel.source || !channel.playing) continue;
      channel.pausedOffset = this.playbackOffset(channel, now);
      const currentGain = this.gainAt(channel, now);
      channel.fadeRemaining = Math.max(0, channel.fadeEnd - now);
      channel.fadeFrom = currentGain;
      if (channel.fadeTimer !== null) clearTimeout(channel.fadeTimer);
      channel.fadeTimer = null;
      channel.fadeGeneration++;
      channel.gain.gain.cancelScheduledValues(now);
      channel.gain.gain.setValueAtTime(currentGain, now);
      channel.fadeStart = 0;
      channel.fadeEnd = 0;
      channel.source.onended = null;
      try { channel.source.stop(); } catch {}
      channel.source.disconnect();
      channel.source = null;
    }
    return true;
  }

  async resumeForLoad(paused) {
    if (!paused || !this.loadPauses) return;
    this.loadPauses--;
    if (this.loadPauses) return;
    const now = this.context().currentTime;
    for (const [id, channel] of this.channels.entries()) {
      if (channel.pausedOffset === null || !channel.playing || !channel.buffer) continue;
      const remaining = channel.fadeRemaining;
      const stopAfterFade = channel.fadeStop;
      if (stopAfterFade && remaining <= 0) {
        this.stop(id);
        continue;
      }
      if (!this.startSource(channel, channel.pausedOffset)) continue;
      if (remaining > 0) {
        const end = now + remaining;
        channel.gain.gain.cancelScheduledValues(now);
        channel.gain.gain.setValueAtTime(channel.fadeFrom, now);
        channel.gain.gain.linearRampToValueAtTime(channel.fadeTo, end);
        channel.fadeStart = now;
        channel.fadeEnd = end;
        channel.fadeRemaining = 0;
        if (stopAfterFade) this.armFadeStop(id);
      }
    }
  }
}
