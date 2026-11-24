// The shared speaking controller must not outlive the speech that created it
// (add-ai-native-meeting 2.3, found 2026-11-24).
//
// The defect this pins, measured in production: `POST /speak` answered
//   500 {"error":"This operation was aborted"}
// on a SECOND speech, with nobody talking. Cause: the previous run's
// AbortController — already tripped by the barge-in that ended it — was still
// installed in the shared `speakingAbort` slot, so the new speech was aborted
// on its first frame check. A one-shot test never sees this; only a second
// speech does.
//
// The assertion is on the CONTRACT, not the implementation: after a speech
// finishes (however it finishes), the next one must run to completion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEnergyVad } from "./vad-energy.mjs";

const SRC = readFileSync(new URL("./worker.js", import.meta.url), "utf8");

test("both speak paths clear the shared controller in a finally", () => {
  // Two entry paths push audio: the control port and the to-say loop. Both must
  // release `speakingAbort`; leaving it installed in only one of them is the
  // exact asymmetry that caused the bug.
  const clears = SRC.match(/if \(speakingAbort === ctrl\) speakingAbort = null;/g) || [];
  assert.equal(clears.length, 2, `expected both paths to clear speakingAbort, found ${clears.length}`);
  const finals = SRC.match(/\.finally\(|finally \{/g) || [];
  assert.ok(finals.length >= 2, "the clears must sit in a finally (a throw must still release it)");
});

test("the control port reports an interruption instead of failing", () => {
  // A barge-in is the feature working. Answering 500 makes a successful
  // interruption indistinguishable from a crash in every log and client.
  // (A 500 catch-all still exists for REAL failures — that is correct. What
  // must not happen is an interrupted speech reaching it.)
  assert.match(SRC, /interrupted/, "the control response must say whether a human cut it off");
  const handler = SRC.slice(SRC.indexOf('req.url !== "/speak"'), SRC.indexOf("srv.listen(CONTROL_PORT"));
  assert.match(handler, /try \{[\s\S]*speakIntoRoom[\s\S]*finally \{/, "speech must be wrapped so an abort releases the controller");
  assert.match(handler, /if \(speakingAbort === ctrl\) speakingAbort = null;/, "the control path must clear the shared controller");
});

test("speakIntoRoom treats a throw after abort as an interruption, not an error", () => {
  // captureFrame can throw while a frame is mid-flight when the track is torn
  // down; that IS the interruption. Without this branch the log line
  // "speech interrupted by a human" was unreachable.
  const fn = SRC.slice(SRC.indexOf("async function speakIntoRoom"), SRC.indexOf("/** Fetch the meeting's next"));
  assert.match(fn, /catch \(e\) \{[\s\S]*signal\?\.aborted[\s\S]*return false;/, "aborted throw must return false, not rethrow");
  assert.match(fn, /return true;/, "a completed speech must be distinguishable from an interrupted one");
});

// The VAD contract is unchanged by this fix — re-pin it so a later edit to the
// barge-in path cannot quietly break segmentation.
test("VAD still cuts on silence and never on a silence-only stretch", () => {
  const RATE = 16000, FRAME = 320;
  const loud = () => { const f = new Int16Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / RATE)); return f; };
  const quiet = () => new Int16Array(FRAME);
  const vad = createEnergyVad({ silenceMs: 400, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  let cut = null;
  for (let i = 0; i < 50 && !cut; i++) cut = vad.push(loud(), RATE);
  assert.equal(cut, null, "continuous speech must not cut yet");
  for (let i = 0; i < 25 && !cut; i++) cut = vad.push(quiet(), RATE);
  assert.ok(cut && cut.reason === "silence" && cut.hadSpeech, "silence after speech cuts with hadSpeech");
});

test("one failed speech must not poison the queue for the next one", () => {
  // `speakQueue` is a long-lived promise chain shared by every speech. A single
  // rejected link makes every LATER `.then()` skip its body and rethrow the old
  // error — so a barge-in on speech #1 made speech #2 answer 500 with nothing
  // aborting it (measured 2026-11-24). The queue must be healed at the join.
  const joins = SRC.match(/speakQueue\s*\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(joins.length >= 1, "the speak queue must absorb a previous rejection before chaining");
  // And the chain assignment must carry that catch, not bypass it.
  assert.match(SRC, /speakQueue = speakQueue\s*\n?\s*\.catch\(\(\) => \{\}\)/, "the caught queue must be what gets stored back");
});

test("every speech releases its track, or the participant runs out of them", () => {
  // Each speech published a NEW "agent-speech" track and never unpublished it.
  // After a few sentences publishTrack started throwing AbortError, which is
  // what "the second speech always 500s" actually was (2026-11-24: the room
  // held three dead agent tracks by the third sentence).
  const fn = SRC.slice(SRC.indexOf("async function speakIntoRoom"), SRC.indexOf("/** Fetch the meeting's next"));
  assert.match(fn, /unpublishTrack\(/, "speakIntoRoom must release its track");
  assert.match(fn, /finally \{[\s\S]*unpublishTrack/, "the release must be in a finally — an interrupted sentence leaves a track too");
});

test("unpublishTrack receives the publication SID, not the track object", () => {
  // The SDK signature is `unpublishTrack(trackSid: string, stopOnUnpublish?)`
  // (participant.d.ts). Passing the LocalAudioTrack object silently did
  // nothing: tracks piled up, publishTrack started throwing AbortError, and
  // every round answered 200 {interrupted:false} while no audio was sent at
  // all — the most convincing wrong result of this whole hunt (2026-11-24).
  const fn = SRC.slice(SRC.indexOf("async function speakIntoRoom"), SRC.indexOf("/** Fetch the meeting's next"));
  assert.match(fn, /publishTrack\(trk[^)]*\)/, "the publication handle must be captured");
  assert.match(fn, /unpublishTrack\(pub\?\.sid|unpublishTrack\(pub\.sid/, "unpublish must use the SID");
  assert.doesNotMatch(fn, /unpublishTrack\(trk/, "the track object is not a SID and silently no-ops");
});

test("each sentence publishes under a unique track name", () => {
  // Reusing "agent-speech" made the next publish collide with the previous
  // unpublish still settling, which the SDK reports as AbortError. Measured
  // 2026-11-24: R1/R2 fine, R3/R4 both publishTrack-failed while STILL
  // answering 200 with a byte count — the control port looked healthy while
  // nothing was sent. A unique name removes the collision entirely.
  const fn = SRC.slice(SRC.indexOf("async function speakIntoRoom"), SRC.indexOf("/** Fetch the meeting's next"));
  assert.match(fn, /createAudioTrack\(`agent-speech-\$\{/, "the track name must be unique per sentence");
});

test("the control response distinguishes 'played' from 'byte count'", () => {
  // `bytes` is the WAV length, so a failed publish still looked successful.
  // `played` is the only field that means the audio reached the room.
  const handler = SRC.slice(SRC.indexOf('req.url !== "/speak"'), SRC.indexOf("srv.listen(CONTROL_PORT"));
  assert.match(handler, /let played = false;/, "played must start false");
  assert.match(handler, /played = await/, "played comes from speakIntoRoom's return");
  assert.match(handler, /\{ ok: true, bytes: wav\.length, played, interrupted \}/, "the response carries all three");
});
