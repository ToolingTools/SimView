import { describe, expect, test } from "bun:test";
import { packetsFromLatestKeyframe } from "../packages/mcp/src/preview";

describe("embedded preview reset recovery", () => {
  const packets = [
    { sequence: 1, keyframe: true, data: "old-keyframe" },
    { sequence: 2, keyframe: false, data: "old-delta" },
    { sequence: 3, keyframe: true, data: "latest-keyframe" },
    { sequence: 4, keyframe: false, data: "latest-delta" },
    { sequence: 5, keyframe: false, data: "next-delta" },
  ];

  test("resumes from the newest cached keyframe", () => {
    expect(packetsFromLatestKeyframe(packets, 2)).toEqual(packets.slice(2, 4));
  });

  test("only considers keyframes newer than a recovery cursor", () => {
    expect(packetsFromLatestKeyframe(packets, 3, 1)).toEqual(packets.slice(2, 5));
    expect(packetsFromLatestKeyframe(packets, 3, 3)).toEqual([]);
  });
});
