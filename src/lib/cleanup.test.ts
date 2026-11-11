import { describe, expect, it } from "vitest";

import { handOver, keepReason, rankCopies, type Copy } from "./cleanup";

const copy = (over: Partial<Copy>): Copy => ({
  id: "x", path: "/m/x", durationSec: 300, present: true, playlists: 0, bitrate: 320, sampleRate: 44_100,
  fileType: 1, analysed: true, rating: 0, dateAdded: "2026-01-01", cues: 0, ...over,
});

describe("rankCopies", () => {
  it("never keeps a missing file over one that plays", () => {
    const [keep] = rankCopies([copy({ id: "gone", present: false, cues: 9 }), copy({ id: "here" })]);
    expect(keep?.id).toBe("here");
  });
  it("prefers cues, then playlists, then lossless", () => {
    expect(rankCopies([copy({ id: "a", playlists: 5 }), copy({ id: "b", cues: 3 })])[0]?.id).toBe("b");
    expect(rankCopies([copy({ id: "a", fileType: 12, bitrate: 1411 }), copy({ id: "b", playlists: 1 })])[0]?.id).toBe("b");
    expect(rankCopies([copy({ id: "mp3", fileType: 1, bitrate: 320 }), copy({ id: "aiff", fileType: 12, bitrate: 1411 })])[0]?.id).toBe("aiff");
  });
  it("falls back to the copy added first", () => {
    expect(rankCopies([copy({ id: "new", dateAdded: "2026-10-01" }), copy({ id: "old", dateAdded: "2025-03-01" })])[0]?.id).toBe("old");
  });
});

describe("keepReason", () => {
  it("names the deciding step", () => {
    expect(keepReason(copy({ cues: 4 }), [copy({ cues: 0 })])).toBe("most cues (4)");
    expect(keepReason(copy({ fileType: 12 }), [copy({ fileType: 1 })])).toBe("lossless");
  });
});

describe("handOver", () => {
  it("puts the kept copy where the removed one was", () => {
    expect(handOver(["a", "gone", "b"], "gone", "keep")).toEqual(["a", "keep", "b"]);
  });
  it("does not list the kept copy twice", () => {
    expect(handOver(["keep", "a", "gone"], "gone", "keep")).toEqual(["keep", "a"]);
  });
});

describe("handOver after the kept copy is added", () => {
  it("is worked out from the list before the add, so the kept copy takes the removed one's place", () => {
    // The playlist was [a, gone, b]; adding keep appends it, but the new
    // order comes from the list as it was.
    expect(handOver(["a", "gone", "b"], "gone", "keep")).toEqual(["a", "keep", "b"]);
  });
});
