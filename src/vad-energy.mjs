// 能量门限 VAD：按静音边界切，而不是固定时长。零依赖。
export function createEnergyVad({ silenceMs = 700, minSpeechMs = 300, maxSegmentMs = 15000, frameMs = 20, rmsThreshold = 500 } = {}) {
  let buf = [];
  let speechMs = 0, silenceMsAcc = 0, totalMs = 0;
  const rms = (i16) => { let s = 0; for (let i=0;i<i16.length;i++) s += i16[i]*i16[i]; return Math.sqrt(s/i16.length); };
  return {
    /** push(frame: Int16Array, sampleRate) → { segment?: Int16Array[], reason } | null */
    push(frame, sampleRate) {
      const ms = (frame.length / sampleRate) * 1000;
      const loud = rms(frame) >= rmsThreshold;
      buf.push(frame); totalMs += ms;
      if (loud) { speechMs += ms; silenceMsAcc = 0; }
      else { silenceMsAcc += ms; }
      // Flush when EITHER: a spoken stretch ended in enough silence, OR we have
      // been silent long enough that the buffer is just noise (hadSpeech=false,
      // so the caller drops it — but the buffer MUST not grow unbounded).
      const spokeThenPaused = speechMs >= minSpeechMs && silenceMsAcc >= silenceMs;
      const allSilence = speechMs === 0 && silenceMsAcc >= silenceMs;
      const ended = spokeThenPaused || allSilence;
      const capped = totalMs >= maxSegmentMs;
      if (ended || capped) {
        const seg = buf; const hadSpeech = speechMs >= minSpeechMs;
        buf = []; speechMs = 0; silenceMsAcc = 0; totalMs = 0;
        return { segment: seg, reason: capped ? "max" : "silence", hadSpeech };
      }
      return null;
    },
  };
}
