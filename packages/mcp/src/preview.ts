export interface BufferedPreviewPacket {
  sequence: number;
  keyframe: boolean;
}

export function packetsFromLatestKeyframe<T extends BufferedPreviewPacket>(
  packets: readonly T[],
  limit: number,
  afterSequence?: number,
): T[] {
  let keyframeIndex = -1;
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    if (packet?.keyframe && (afterSequence === undefined || packet.sequence > afterSequence)) {
      keyframeIndex = index;
    }
  }
  return keyframeIndex < 0 ? [] : packets.slice(keyframeIndex, keyframeIndex + limit);
}
