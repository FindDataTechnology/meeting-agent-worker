// Energy VAD for the meeting worker (openspec: add-ai-native-meeting 2.1 fix).
//
// The production defect this guards against (2026-11-24): a fixed 2 s cut split
// one sentence into "里的一段真实。" + "齿发言。". The contract:
//   • cut at SILENCE, so a whole utterance stays together
//   • a silence-only stretch produces NO segment (never transcribe silence)
//   • a long monologue is force-cut at maxSegmentMs (bounded memory)
//
//   node --test src/vad-energy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnergyVad } from "./vad-energy.mjs";

const RATE = 16000;
const FRAME = 320; // 20 ms @ 16k
const loud = (amp = 6000) => { const f = new Int16Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE)); return f; };
const quiet = () => new Int16Array(FRAME);
const feed = (vad, frame, n) => { const out = []; for (let i = 0; i < n; i++) { const r = vad.push(frame(), RATE); if (r) out.push(r); } return out; };

test("a sentence followed by silence cuts once, at the silence boundary", () => {
  const vad = createEnergyVad({ silenceMs: 400, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  let cuts = [];
  cuts.push(...feed(vad, loud, 50)); // 1s speech
  cuts.push(...feed(vad, quiet, 25)); // 0.5s silence -> should cut
  assert.equal(cuts.length, 1, "one cut");
  assert.equal(cuts[0].reason, "silence");
  assert.equal(cuts[0].hadSpeech, true);
  // ~1s speech + up to the silence threshold, NOT a fixed 2s
  const ms = (cuts[0].segment.reduce((n, f) => n + f.length, 0) / RATE) * 1000;
  assert.ok(ms >= 1000 && ms < 1500, `segment ~1-1.4s, got ${ms.toFixed(0)}ms`);
});

test("silence-only stretch yields a segment flagged hadSpeech=false (caller drops it)", () => {
  const vad = createEnergyVad({ silenceMs: 300, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  let cut = null;
  for (let i = 0; i < 40 && !cut; i++) cut = vad.push(quiet(), RATE);
  assert.ok(cut, "a long silence must eventually flush a segment");
  assert.equal(cut.hadSpeech, false, "flagged as no-speech so the worker skips STT");
});

test("a long monologue is force-cut at maxSegmentMs (bounded memory)", () => {
  const vad = createEnergyVad({ silenceMs: 700, minSpeechMs: 100, maxSegmentMs: 2000, rmsThreshold: 500 });
  let cuts = [];
  cuts.push(...feed(vad, loud, 150)); // 3s of continuous speech, no silence
  assert.ok(cuts.length >= 1, "forced cut happened");
  assert.equal(cuts[0].reason, "max");
  const ms = (cuts[0].segment.reduce((n, f) => n + f.length, 0) / RATE) * 1000;
  assert.ok(ms >= 2000, `hit the ceiling, got ${ms.toFixed(0)}ms`);
});

test("threshold makes amplitude matter: very quiet frames never count as speech", () => {
  const vad = createEnergyVad({ silenceMs: 300, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  let cut = null;
  for (let i = 0; i < 40 && !cut; i++) cut = vad.push(loud(50), RATE); // tiny amplitude < threshold
  assert.ok(cut);
  assert.equal(cut.hadSpeech, false, "amplitude below threshold is not speech");
});

test("speech flags the frame, so barge-in fires on voice and not on silence", () => {
  // The barge-in decision is per-FRAME: "did this frame contain a human voice".
  // Aborting on every frame (including silence) killed the next speech the
  // instant it began — measured 2026-11-24, a second /speak answered 500
  // "This operation was aborted" with nobody talking.
  const vad = createEnergyVad({ silenceMs: 400, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  vad.push(loud(), RATE);
  assert.equal(vad.speech, true, "a loud frame is speech");
  vad.push(quiet(), RATE);
  assert.equal(vad.speech, false, "a silent frame is not speech");
  vad.push(loud(50), RATE); // below the threshold
  assert.equal(vad.speech, false, "amplitude under the threshold is not speech");
});

test("speech is not carried over: a silent frame after a loud one reads false", () => {
  const vad = createEnergyVad({ silenceMs: 400, minSpeechMs: 100, maxSegmentMs: 15000, rmsThreshold: 500 });
  for (let i = 0; i < 5; i++) vad.push(loud(), RATE);
  assert.equal(vad.speech, true);
  for (let i = 0; i < 5; i++) vad.push(quiet(), RATE);
  assert.equal(vad.speech, false, "a stale true would keep aborting the agent forever");
});
