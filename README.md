# meeting-agent-worker

The media pump for AI-native meetings (openspec: `add-ai-native-meeting` 2.1/2.2).

It joins a LiveKit room as an **agent participant**, subscribes each human's
audio, segments it (~2 s), and hands each segment to the platform for STT —
which delivers it into the room as a per-speaker message. It also **speaks** on
request: the platform posts text to the worker's control door, the worker asks
the platform's speak route for audio (the deployment's TTS + the voice catalog),
and pushes it onto a published track.

## It holds no key

The worker has NO model credential. Every model call is made by the platform
(词元 STT/TTS under the deployment key); the worker only moves audio and
exchanges text. That is why it can run as a separate, low-trust service.

## Why a separate image

`@livekit/rtc-node` carries a native FFI binding. paas stays lean and has **zero**
livekit dependency — its meeting routes are plain HTTP. So this ships on its own,
the way the browser lane ships chromium separately.

## Env

| var | meaning |
|---|---|
| `MEETING_LIVEKIT_URL` / `_KEY` / `_SECRET` | where to connect, how to auth |
| `MEETING_ROOM` / `MEETING_ID` | LiveKit room and the platform meeting id |
| `PLATFORM_BASE` | e.g. `http://platform.fd-prod:3000` |
| `GATEWAY_SECRET` | machine credential (== the platform's `CELL_GATEWAY_SECRET`) |
| `ACTOR_EMAIL` | the seat this worker speaks as |
| `WORKER_CONTROL_PORT` | >0 opens `POST /speak` (loopback); 0 = hear-only |

## Chain

GHA → hkccr → cheap9 relay → ccr; nodes pull from ccr. Verify from a node:

```
k3s ctr -n k8s.io images pull ccr.ccs.tencentyun.com/fd-web/meeting-agent-worker:<tag>
```
