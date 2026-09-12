// Return the first BGM command at or after the VM's resolved bytecode offset.
// Timelines are emitted in ascending statement order by the asset packer.
export function nextTimelineMusic(timeline, offset) {
  if (!Array.isArray(timeline) || !timeline.length || !Number.isFinite(offset)) return null;
  let low = 0, high = timeline.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeline[middle].offset < offset) low = middle + 1;
    else high = middle;
  }
  return low < timeline.length ? timeline[low].music : null;
}
