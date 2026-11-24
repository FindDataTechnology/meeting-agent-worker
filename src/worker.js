// ── Meeting agent worker (add-ai-native-meeting 2.1/2.2) ─────────────────────
//
// The media pump. It joins a LiveKit room as an agent participant, subscribes
// to each human's audio track, segments it (~2s), and does exactly two things
// through the PLATFORM's machine door — never with a key of its own:
//
//   hear:  POST {platform}/api/zhiyu/meetings/:id/utterance   (audio in → text in room)
//   speak: POST {platform}/api/zhiyu/meetings/:id/speak        (text → audio track)
//
// Both calls carry `x-cloud-gateway-secret` + `x-actor-email`, the same machine
// credential `capture-ingest` uses. The worker holds NO model key: the platform
// does STT/TTS with its deployment credential, so a compromised worker cannot
// spend money or reach a member's account.
//
// This file is deliberately small and dependency-light: it is the process, the
// routing lives in gateway/zhiyu/meeting-agent.js and the routes.
//
// Env:
//   MEETING_LIVEKIT_URL / _KEY / _SECRET   where to connect, how to authenticate
//   MEETING_ROOM                            LiveKit room name (== platform meeting id mapping done by caller)
//   PLATFORM_BASE                           e.g. http://127.0.0.1:3000
//   GATEWAY_SECRET                          machine credential (== CELL_GATEWAY_SECRET)
//   ACTOR_EMAIL                             the seat this worker speaks as
import { AccessToken } from "livekit-server-sdk";
import { createEnergyVad } from "./vad-energy.mjs";
import { Room, RoomEvent, AudioStream, TrackKind, AudioSource, LocalAudioTrack, TrackPublishOptions, AudioFrame } from "@livekit/rtc-node";
import { timingSafeEqual } from "node:crypto";
const secretMatches = (a, b) => {
  if (typeof a !== "string" || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const env = process.env;
const LK_URL = env.MEETING_LIVEKIT_URL;
const LK_KEY = env.MEETING_LIVEKIT_KEY;
const LK_SECRET = env.MEETING_LIVEKIT_SECRET;
// MEETING_ID is the only identity the worker is given; the LiveKit room name
// comes from the platform (the meeting row), not from an env var. MEETING_ROOM
// stays as an explicit override for a one-off / test run.
const MEETING_ID = env.MEETING_ID || "";
const ROOM_OVERRIDE = env.MEETING_ROOM || "";
const PLATFORM = (env.PLATFORM_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const GATEWAY_SECRET = env.GATEWAY_SECRET || "";
const ACTOR_EMAIL = env.ACTOR_EMAIL || "";

if (!LK_URL || !LK_KEY || !LK_SECRET || (!MEETING_ID && !ROOM_OVERRIDE)) {
  console.error("[meeting-worker] need MEETING_LIVEKIT_URL/_KEY/_SECRET and either MEETING_ID (resolved via platform) or MEETING_ROOM (override)");
  process.exit(2);
}


/** PCM frames → a WAV buffer (16-bit mono). */
function wavFromPcm(frames, sampleRate, channels) {
  const dataLen = frames.reduce((n, f) => n + f.length * 2, 0);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (const f of frames) for (let i = 0; i < f.length; i++) { buf.writeInt16LE(f[i], off); off += 2; }
  return buf;
}

const machineHeaders = () => {
  const h = { "x-cloud-gateway-secret": GATEWAY_SECRET };
  if (ACTOR_EMAIL) h["x-actor-email"] = ACTOR_EMAIL;
  return h;
};

/** Hear: hand one participant's audio segment to the platform for STT. */
async function ingestUtterance({ seatRef, wav }) {
  // The platform route does STT + attribution + room delivery in one hop, so the
  // worker never calls the model lane itself and never holds the key.
  const form = new FormData();
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "segment.wav");
  form.append("seatRef", seatRef);
  try {
    const r = await fetch(`${PLATFORM}/api/zhiyu/meetings/${encodeURIComponent(MEETING_ID)}/utterance`, {
      method: "POST",
      headers: machineHeaders(),
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[meeting-worker] utterance ${seatRef}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    return j;
  } catch (e) {
    console.error("[meeting-worker] utterance failed:", e?.message || e);
    return null;
  }
}

/** Speak: platform synthesises text in the resolved voice; we return the WAV. */
export async function synthesizeForMeeting({ text, seatRef }) {
  const r = await fetch(`${PLATFORM}/api/zhiyu/meetings/${encodeURIComponent(MEETING_ID)}/speak`, {
    method: "POST",
    headers: { ...machineHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ text, seatRef }),
  });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer()); // WAV
}

/** Push a WAV buffer (16k mono) onto a published audio track. */
// Barge-in (add-ai-native-meeting 2.3): a person talking stops the agent mid
// sentence. An AbortSignal is the whole mechanism — the speak loop checks it per
// frame. "Yield the turn to the human" is not compliance, it is this one flag.
let speakingAbort = null;

async function speakIntoRoom(room, wav, signal = null) {
  const pcm = new Int16Array((wav.length - 44) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(44 + i * 2);
  const src = new AudioSource(16000, 1);
  // A UNIQUE track name per sentence. Reusing "agent-speech" made the next
  // publish collide with the previous unpublish still settling, which the SDK
  // reports as AbortError — the same symptom as the track leak, arriving by a
  // different route (measured 2026-11-24: R1 and R2 fine, R3 and R4 both
  // publishTrack-failed while still answering 200 with a byte count, so the
  // control port looked healthy while nothing was being sent).
  const trk = LocalAudioTrack.createAudioTrack(`agent-speech-${Date.now()}`, src);
  let pub = null;
  try {
    pub = await room.localParticipant.publishTrack(trk, new TrackPublishOptions());
  } catch (e) {
    // Publishing can fail when the previous track is still being torn down.
    // Left unguarded it escaped as a 500 whose message ("This operation was
    // aborted") had nothing to do with this speech — the one failure mode that
    // made every fix before this one look like it had not worked.
    console.log(`[meeting-worker] publishTrack failed (${e?.name || "?"}: ${e?.message || e}); treating as no-speech`);
    return false;
  }
  try {
    const f = new Int16Array(320);
    for (let n = 0; n + 320 <= pcm.length; n += 320) {
      if (signal?.aborted) { console.log("[meeting-worker] speech interrupted by a human"); return false; }
      for (let i = 0; i < 320; i++) f[i] = pcm[n + i];
      await src.captureFrame(new AudioFrame(f, 16000, 1, 320));
    }
    return true;
  } catch (e) {
    // A barge-in can land while a frame is mid-flight: the track is torn down
    // under us and captureFrame throws instead of returning. That IS the
    // interruption, not a failure.
    if (signal?.aborted) { console.log("[meeting-worker] speech interrupted by a human"); return false; }
    console.log(`[meeting-worker] captureFrame failed (${e?.name || "?"}: ${e?.message || e})`);
    return false;
  } finally {
    // UNPUBLISH when the sentence ends (2026-11-24). Without this every speech
    // published ANOTHER "agent-speech" track and never released it; after a few
    // sentences publishTrack started throwing AbortError — which surfaced as
    // "the second speech always fails".
    //
    // `unpublishTrack` takes the publication SID, not the track object
    // (participant.d.ts). Passing the track published nothing here — the tracks
    // stayed, publishTrack kept failing, and every round answered
    // `200 {interrupted:false}` while no audio was actually sent.
    if (pub?.sid) { try { await room.localParticipant.unpublishTrack(pub.sid, true); } catch { /* already gone */ } }  }
}

/** Fetch the meeting's next agent utterances to speak (add-ai-native-meeting 2.3). */
async function toSay(afterSeq) {
  const r = await fetch(`${PLATFORM}/api/zhiyu/meetings/${encodeURIComponent(MEETING_ID)}/to-say?after=${afterSeq}`, { headers: machineHeaders() });
  if (!r.ok) return null;
  return r.json();
}

/** Ask the platform which media room this meeting is. */
async function resolveRoom() {
  if (ROOM_OVERRIDE) return ROOM_OVERRIDE;
  const r = await fetch(`${PLATFORM}/api/zhiyu/meetings/${encodeURIComponent(MEETING_ID)}/media`, { headers: machineHeaders() });
  if (!r.ok) throw new Error(`meeting media lookup failed: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  if (!j.livekitRoom) throw new Error("meeting has no media room");
  return j.livekitRoom;
}

async function main() {
  const ROOM = await resolveRoom();
  console.log(`[meeting-worker] meeting ${MEETING_ID || "(override)"} → media room ${ROOM}`);
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: `agent:${ACTOR_EMAIL || "meeting"}`, name: "会中助手", ttl: "6h" });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true, agent: true });
  const room = new Room();

  room.on(RoomEvent.TrackSubscribed, async (track, pub, part) => {
    if (pub.kind !== TrackKind.KIND_AUDIO) return;
    console.log(`[meeting-worker] subscribed audio from ${part.identity}`);
    const reader = new AudioStream(track).getReader();
    // Cut on SILENCE, not on a fixed clock. The fixed 2 s cut split one sentence
    // into "里的一段真实。" + "齿发言。" in production (2026-11-24); an energy VAD
    // keeps a whole utterance together and drops pure silence instead of
    // transcribing it.
    const vad = createEnergyVad({
      silenceMs: Number(env.MEETING_VAD_SILENCE_MS) || 700,
      minSpeechMs: Number(env.MEETING_VAD_MIN_SPEECH_MS) || 300,
      maxSegmentMs: Number(env.MEETING_VAD_MAX_MS) || 15000,
      rmsThreshold: Number(env.MEETING_VAD_RMS) || 500,
    });
    let rate = 48000, ch = 1;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rate = value.sampleRate; ch = value.channels;
        const cut = vad.push(value.data, rate);
        // A person is TALKING: stop the agent's current sentence (barge-in).
        // Gated on the frame actually containing speech — the unconditional
        // version aborted on silence too, which meant the echo frames still
        // draining from a publisher that had already left would kill the NEXT
        // speech the instant it started (measured 2026-11-24).
        if (vad.speech && speakingAbort && !speakingAbort.aborted) speakingAbort.abort();
        if (cut) {
          if (!cut.hadSpeech) continue; // silence-only stretch: nothing to transcribe
          const wav = wavFromPcm(cut.segment, rate, ch);
          // seatRef = the participant identity (worker joins with identity == seat ref).
          await ingestUtterance({ seatRef: part.identity, wav });
        }
      }
    } catch (e) {
      console.log("[meeting-worker] stream ended", part.identity, e?.message);
    }
  });

  await room.connect(LK_URL, await at.toJwt());
  console.log(`[meeting-worker] joined ${ROOM} as agent; listening`);

  // ── control door: speak on request ─────────────────────────────────────────
  // The platform asks the worker to say something (the seat was addressed).
  // A tiny HTTP face, bound to loopback by default, guarded by the SAME machine
  // secret the worker uses outbound — so only the platform can make the agent
  // talk, and the worker still holds no model key (it forwards the text to the
  // platform's speak route, which does the TTS).
  let speakQueue = Promise.resolve();
  const CONTROL_PORT = Number(env.WORKER_CONTROL_PORT) || 0;
  // Default loopback for a one-off test; in-cluster the deployment sets 0.0.0.0
  // so the platform can push "now speak this" (add-ai-native-meeting 2.3).
  const CONTROL_HOST = env.WORKER_CONTROL_HOST || "127.0.0.1";
  if (CONTROL_PORT > 0) {
    const http = await import("node:http");
    const srv = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/speak") { res.writeHead(404); return res.end(); }
      if (!secretMatches(req.headers["x-cloud-gateway-secret"], GATEWAY_SECRET)) { res.writeHead(401); return res.end(); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { text, seatRef } = JSON.parse(body || "{}");
          const wav = await synthesizeForMeeting({ text: String(text || ""), seatRef: String(seatRef || ACTOR_EMAIL) });
          if (!wav) { res.writeHead(502); return res.end(JSON.stringify({ error: "synthesis failed" })); }
          // Barge-in must work here too (2026-11-24). This endpoint used to call
          // speakIntoRoom without a signal, so a human talking could stop the
          // to-say loop's speech but NOT speech pushed through the control port —
          // the same feature behaving differently on its two entry paths. The
          // controller is shared with the loop on purpose: one speakingAbort, so
          // a human stops whatever is currently being said regardless of which
          // path started it.
          const ctrl = new AbortController();
          speakingAbort = ctrl;
          // One speak at a time: two concurrent pushes onto the same track would
          // interleave into gibberish, so serialize.
          let interrupted = false;
          try {
            // `.catch(() => {})` on the QUEUE, not just on this call: the queue
            // is a long-lived chain, so one rejected link poisons every later
            // speech — the next /speak would skip its body and rethrow the old
            // error. That is exactly the shape of the 2026-11-24 defect: a
            // barge-in on speech #1 made speech #2 answer 500 "This operation
            // was aborted" even though nothing was aborting it.
            await (speakQueue = speakQueue
              .catch(() => {})
              .then(() => speakIntoRoom(room, wav, ctrl.signal)));
            interrupted = ctrl.signal.aborted;
          } finally {
            // Clear the shared controller when THIS speech ends. Leaving a spent
            // (or aborted) controller in `speakingAbort` made the next speech
            // inherit it: measured 2026-11-24, a second /speak answered 500
            // "This operation was aborted" without any human talking, because
            // the previous run's controller was still installed and already
            // tripped by the barge-in that ended it.
            if (speakingAbort === ctrl) speakingAbort = null;
          }
          // A barge-in is a SUCCESSFUL outcome, not a 500: the caller asked for
          // speech and a human took the floor. Reporting the difference is what
          // lets a tester (or the platform) tell "it stopped because someone
          // spoke" from "it broke".
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, bytes: wav.length, interrupted }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e?.message || e) })); }
      });
    });
    srv.listen(CONTROL_PORT, CONTROL_HOST, () => console.log(`[meeting-worker] control on ${CONTROL_HOST}:${CONTROL_PORT}`));
  }
  // ── speak loop (2.3): poll for the room's agent replies and say them ──────
  // The agent decides whether/what to answer in the ROOM (its own a2a turn); the
  // worker only voices what the room already decided. Cursor-based so a missed
  // poll is recovered on the next one; speaking is serialized on one track.
  let cursor = Number(env.MEETING_SAY_CURSOR || 0) || 0;
  let saying = Promise.resolve();
  if (MEETING_ID) {
    const POLL_MS = Number(env.MEETING_SAY_POLL_MS) || 2000;
    console.log(`[meeting-worker] speak loop started, cursor=${cursor}, poll=${POLL_MS}ms`);
    const timer = setInterval(async () => {
      try {
        const j = await toSay(cursor);
        if (!j) return;
        // Advance the cursor only PAST what we actually spoke. A synthesis that
        // fails (the 词元 lane 503s intermittently) must NOT consume the cursor,
        // or that answer is lost with no record. Items are contiguous from the
        // server, so on the first failure we stop and retry from there next poll.
        let next = cursor;
        for (const item of j.items || []) {
          const wav = await synthesizeForMeeting({ text: item.text, seatRef: ACTOR_EMAIL });
          if (!wav) {
            console.log(`[meeting-worker] synthesis failed at seq ${item.seq}; holding cursor at ${next} for retry`);
            break;
          }
          const ctrl = new AbortController();
          speakingAbort = ctrl;
          // Clear the controller when this item ends, for the same reason the
          // control port does: a spent or tripped controller left in
          // `speakingAbort` makes the NEXT speech inherit it and abort instantly.
          saying = saying
            .then(() => speakIntoRoom(room, wav, ctrl.signal))
            .catch(() => {})
            .finally(() => { if (speakingAbort === ctrl) speakingAbort = null; });
          console.log(`[meeting-worker] saying seq ${item.seq}: ${item.text.slice(0, 40)}`);
          next = item.seq;
        }
        cursor = next;
      } catch (e) { console.log("[meeting-worker] to-say poll failed:", e?.message || e); }
    }, POLL_MS);
    timer.unref?.();
  }

  const shutdown = async () => { try { await room.disconnect(); } catch {} process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("[meeting-worker] fatal:", e); process.exit(1); });
}

export { wavFromPcm, speakIntoRoom, ingestUtterance };
