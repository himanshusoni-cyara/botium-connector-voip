const { TenVadEngine, SAMPLE_RATE, WINDOW_SIZE } = require('../turn-handlers/ten-vad-engine')
const { pcm16ToFloat32 } = require('../turn-handlers/turn-audio')

const resampleFloat32 = (input, fromRate, toRate) => {
  if (fromRate === toRate) return input
  const outLen = Math.max(1, Math.floor((input.length * toRate) / fromRate))
  const out = new Float32Array(outLen)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const idx = Math.floor(src)
    const frac = src - idx
    const a = input[idx] ?? 0
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0
    out[i] = a + frac * (b - a)
  }
  return out
}

/**
 * Continuous inbound TEN VAD on the full bot leg (Namo commit/reopen acoustic gate).
 */
class InboundLane {
  constructor ({ modelPath, threshold, minSilenceMs, eventEmitter, sessionId, _info, onSpeechStart, onSpeechEnd }) {
    this._modelPath = modelPath
    this._threshold = threshold
    this._minSilenceMs = minSilenceMs
    this._eventEmitter = eventEmitter
    this._sessionId = sessionId
    this._info = _info || (() => {})
    this._onSpeechStart = typeof onSpeechStart === 'function' ? onSpeechStart : null
    this._onSpeechEnd = typeof onSpeechEnd === 'function' ? onSpeechEnd : null
    this._engine = null
    this._loadError = null
    this._floatBuffer = new Float32Array(0)
    this._windowScratch = new Float32Array(WINDOW_SIZE)
    this._pending = []
    this._draining = false
    this._speechActive = false
    this._lastSpeechAt = 0
    this._lastSilentAt = Date.now()
    this._cedRing = new Float32Array(0)
    this._loadPromise = TenVadEngine.create({
      modelPath,
      threshold,
      minSilenceMs
    })
      .then((engine) => {
        this._engine = engine
        return engine
      })
      .catch((err) => {
        this._loadError = err
        throw err
      })
  }

  get speechActive () {
    return this._speechActive
  }

  getCedAudioWindow (windowSamples = SAMPLE_RATE) {
    const n = Math.min(windowSamples, this._cedRing.length)
    if (n <= 0) return null
    return this._cedRing.subarray(this._cedRing.length - n)
  }

  msSinceSpeechSilent () {
    if (this._speechActive) return 0
    return Date.now() - this._lastSilentAt
  }

  _emitActivity (kind) {
    if (!this._eventEmitter) return
    try {
      this._eventEmitter.emit('voip.botActivity', {
        sessionId: this._sessionId,
        kind
      })
    } catch (err) { /* ignore */ }
  }

  _setSpeechActive (active) {
    if (active === this._speechActive) return
    this._speechActive = active
    if (active) {
      this._lastSpeechAt = Date.now()
      this._emitActivity('inbound_speech')
      if (this._onSpeechStart) {
        try { this._onSpeechStart() } catch (err) { /* ignore */ }
      }
    } else {
      this._lastSilentAt = Date.now()
      this._emitActivity('inbound_silent')
      if (this._onSpeechEnd) {
        try { this._onSpeechEnd() } catch (err) { /* ignore */ }
      }
    }
  }

  _queue (fn) {
    this._pending.push(fn)
    const drain = async () => {
      if (this._draining) return
      this._draining = true
      while (this._pending.length) {
        const next = this._pending.shift()
        try {
          await next()
        } catch (err) {
          if (!this._loadError) this._loadError = err
        }
      }
      this._draining = false
    }
    drain().catch(() => {})
  }

  feedPcm16 (pcm, sampleRate, channels = 1) {
    if (!pcm || pcm.length < 2 || !sampleRate) return
    const mono = pcm16ToFloat32(pcm, channels)
    const at16k = resampleFloat32(mono, sampleRate, SAMPLE_RATE)
    const merged = new Float32Array(this._floatBuffer.length + at16k.length)
    merged.set(this._floatBuffer)
    merged.set(at16k, this._floatBuffer.length)
    this._floatBuffer = merged

    const ringMax = SAMPLE_RATE * 2
    const ringMerged = new Float32Array(Math.min(ringMax, this._cedRing.length + at16k.length))
    const copyLen = ringMerged.length
    const tailStart = this._cedRing.length + at16k.length - copyLen
    if (tailStart > 0) {
      ringMerged.set(this._cedRing.subarray(tailStart))
      ringMerged.set(at16k.subarray(Math.max(0, at16k.length - (copyLen - Math.min(this._cedRing.length, tailStart)))), Math.min(this._cedRing.length, tailStart))
    } else {
      ringMerged.set(this._cedRing)
      ringMerged.set(at16k, this._cedRing.length)
    }
    this._cedRing = ringMerged.length >= ringMax
      ? ringMerged.subarray(ringMerged.length - ringMax)
      : ringMerged

    this._queue(async () => {
      if (this._loadError) return
      if (!this._engine) await this._loadPromise
      while (this._floatBuffer.length >= WINDOW_SIZE) {
        this._windowScratch.set(this._floatBuffer.subarray(0, WINDOW_SIZE))
        this._floatBuffer = this._floatBuffer.subarray(WINDOW_SIZE)
        await this._engine.processWindow(this._windowScratch)
        this._setSpeechActive(!!this._engine._triggered)
      }
    })
  }

  blocksOutbound ({ musicDominant = false, hasSttPartials = false } = {}) {
    if (hasSttPartials) return true
    if (musicDominant && !this._speechActive) return false
    return this._speechActive
  }
}

module.exports = { InboundLane, SAMPLE_RATE }
