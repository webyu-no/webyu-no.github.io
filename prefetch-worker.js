/* Decode and verify speculative asset payloads off the page thread. */

async function decodePayload(encoded, compressed) {
  let bytes = new Uint8Array(encoded);
  if (compressed && bytes[0] === 31 && bytes[1] === 139) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function digestHex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async ({data}) => {
  if (!data || data.type !== 'decode') return;
  try {
    const bytes = await decodePayload(data.buffer, data.compressed);
    if (bytes.length !== data.size)
      throw new Error(`Incomplete download: ${data.id}`);
    if (await digestHex(bytes) !== data.sha256)
      throw new Error(`Asset verification failed: ${data.id}`);
    // Transfer ownership; the page inserts this buffer without another copy.
    self.postMessage({type: 'ready', id: data.id, buffer: bytes.buffer}, [bytes.buffer]);
  } catch (error) {
    self.postMessage({type: 'error', id: data.id,
      message: error?.message || String(error)});
  }
};
