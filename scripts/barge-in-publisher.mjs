// Second human participant for the barge-in test (add-ai-native-meeting 5.1).
//
// WHY THIS EXISTS: the barge-in assertion needs a human audio track arriving at
// the worker WHILE the agent is speaking. The dev machine's Chrome is routed to
// a silent virtual device (measured: SinsamSound 2ch yields peak 0.000 on every
// constraint, while ffmpeg on the same box records real signal at -18 dB), so a
// real "talk into the mic" run is impossible here. This publishes the same kind
// of audio the browser would — a human track in the room — so the mechanism can
// be proven without pretending the environment is something it is not.
//
// It joins as a DIFFERENT identity than the agent, publishes one WAV, holds the
// track open briefly, then leaves. The worker should log
// "speech interrupted by a human" the moment frames arrive.
import fs from "node:fs";
import crypto from "node:crypto";
import { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, AudioFrame, RoomEvent } from "@livekit/rtc-node";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint({ key, secret, room, identity, name }) {
  const now = Math.floor(Date.now() / 1000);
  const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: key, sub: identity, name, nbf: now, exp: now + 600,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: false },
  })}`;
  return `${h}.${crypto.createHmac("sha256", secret).update(h).digest("base64url")}`;
}

const { LK_URL, LK_KEY, LK_SECRET, ROOM, WAV, IDENTITY } = process.env;
const token = mint({ key: LK_KEY, secret: LK_SECRET, room: ROOM, identity: IDENTITY, name: "human (barge-in)" });

const room = new Room();
room.on(RoomEvent.Disconnected, () => console.log("[barge] disconnected"));
await room.connect(LK_URL, token);
console.log("[barge] joined", ROOM, "as", IDENTITY);

const wav = fs.readFileSync(WAV);
// 44-byte RIFF header, then 16-bit LE mono PCM at 16 kHz (what the platform's
// TTS returns and what the worker's VAD expects).
const pcm = new Int16Array((wav.length - 44) / 2);
for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(44 + i * 2);

const src = new AudioSource(16000, 1);
const track = LocalAudioTrack.createAudioTrack("human-bargein", src);
await room.localParticipant.publishTrack(track, new TrackPublishOptions());
console.log("[barge] publishing", pcm.length, "samples");

const frame = new Int16Array(320);
for (let n = 0; n + 320 <= pcm.length; n += 320) {
  for (let i = 0; i < 320; i++) frame[i] = pcm[n + i];
  await src.captureFrame(new AudioFrame(frame, 16000, 1, 320));
}
console.log("[barge] finished publishing");
// Hold the participant a moment so the worker's VAD sees the trailing silence
// and cuts the segment (its silenceMs is 400).
await new Promise((r) => setTimeout(r, 1500));
await room.disconnect();
console.log("[barge] left");
