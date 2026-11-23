# Meeting agent worker — a SEPARATE service, not part of the paas image.
#
# Why separate: the worker needs @livekit/rtc-node + its native FFI binding
# (~1.5 MB linux-amd64, but a native lib all the same). paas must stay lean and
# has zero livekit dependency (its meeting routes are plain HTTP). So the media
# pump ships on its own, like the browser lane does for chromium.
#
# Node 22 alpine: the rtc ffI binds against the glibc/musl the image ships; we
# use debian-slim to avoid musl mismatches with prebuilt bindings.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
# No lockfile yet on first build; npm install pins the ranges. Production tag
# control is by the image tag, not by the lockfile here.
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# The worker holds NO model key: it forwards text to the platform's speak route.
ENV WORKER_CONTROL_PORT=0
ENTRYPOINT ["node", "src/worker.js"]
