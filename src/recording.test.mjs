// Recording must never lose audio quietly (add-ai-native-meeting 4.2).
//
// The shape this pins: the worker sends BYTES ONLY (no storage credential), it
// flushes the trailing partial segment, and a refused upload is counted and
// reported rather than dropped. Those are the three ways a recording becomes a
// lie — "the feature is on" while the file is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./worker.js", import.meta.url), "utf8");

test("the worker posts bytes and holds no storage credential", () => {
  assert.match(SRC, /\/recording`/, "the worker must call the recording endpoint");
  // No S3 identifiers anywhere: the credential lives on the platform only.
  for (const forbidden of ["accessKey", "secretKey", "RUSTFS", "S3_ENDPOINT", "aws4"]) {
    assert.ok(!SRC.includes(forbidden), `the worker must not know about ${forbidden}`);
  }
});

test("the trailing partial segment is flushed when the stream ends", () => {
  // Without this, every meeting loses its last <1 minute — and a short meeting
  // (shorter than one segment) would produce NO recording at all.
  assert.match(SRC, /try \{ await flushRecording\(\); \}/, "stream end must flush");
});

test("a refused segment is counted and reported, not swallowed", () => {
  assert.match(SRC, /recDropped \+= 1/, "refusals must be counted");
  assert.match(SRC, /were NOT stored/, "and said out loud at the end");
});

test("silence never becomes an object", () => {
  // A silent segment would make the list look like people spoke when only the
  // room's noise floor was recorded.
  assert.match(SRC, /loudest < \(Number\(env\.MEETING_RECORD_RMS\) \|\| 200\)/, "a quiet segment is skipped");
});

test("recording sees every frame, not just the VAD's sentence cuts", () => {
  // The VAD folds frames into sentences; if recording rode the cuts, the gaps
  // between sentences would vanish and the file would not be the meeting.
  const loop = SRC.slice(SRC.indexOf("for (;;) {"), SRC.indexOf("} catch (e) {\n      console.log(\"[meeting-worker] stream ended\""));
  const recAt = loop.indexOf("recFrames.push");
  const vadAt = loop.indexOf("vad.push");
  assert.ok(recAt > 0 && vadAt > 0, "both must run in the loop");
  assert.ok(recAt < vadAt, "recording consumes the frame BEFORE the VAD folds it");
});
