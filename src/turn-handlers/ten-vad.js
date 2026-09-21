const { TenVadEngine, SAMPLE_RATE, WINDOW_SIZE } = require('./ten-vad-engine')

const pcm16ToMonoFloat32 = (pcm, channels) => {
  const frameBytes = 2 * channels
  const count = Math.floor(pcm.length / frameBytes)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE(i * frameBytes + c * 2)
    }
    out[i] = (sum / channels) / 32768
  }
  return out
}

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

class TenVad {
  constructor ({ modelPath, threshold, minSilenceMs }) {
    this._modelPath = modelPath
    this._threshold = threshold
    this._minSilenceMs = minSilenceMs
    this._engine = null
    this._loadError = null
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

    this._pending = []
    this._floatBuffer = new Float32Array(0)
    this._windowScratch = new Float32Array(WINDOW_SIZE)
    this._onPause = null
    this._hadSpeech = false
  }

  onPause (fn) {
    this._onPause = fn
  }

  reset () {
    this._floatBuffer = new Float32Array(0)
    this._hadSpeech = false
    if (this._engine) this._engine.reset()
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
          // swallow per-chunk errors; init errors surface on first feed
        }
      }
      this._draining = false
    }
    drain().catch(() => {})
  }

  feedPcm16 (pcm, sampleRate, channels = 1) {
    if (!pcm || pcm.length < 2 || !sampleRate) return
    const mono = pcm16ToMonoFloat32(pcm, channels)
    const at16k = resampleFloat32(mono, sampleRate, SAMPLE_RATE)
    const merged = new Float32Array(this._floatBuffer.length + at16k.length)
    merged.set(this._floatBuffer)
    merged.set(at16k, this._floatBuffer.length)
    this._floatBuffer = merged

    this._queue(async () => {
      if (this._loadError) throw this._loadError
      if (!this._engine) await this._loadPromise

      while (this._floatBuffer.length >= WINDOW_SIZE) {
        this._windowScratch.set(this._floatBuffer.subarray(0, WINDOW_SIZE))
        this._floatBuffer = this._floatBuffer.subarray(WINDOW_SIZE)

        const { speech, pause } = await this._engine.processWindow(this._windowScratch)
        if (speech) this._hadSpeech = true

        if (pause && this._hadSpeech) {
          this._hadSpeech = false
          if (this._onPause) this._onPause()
        }
      }
    })
  }
}

module.exports = { TenVad, SAMPLE_RATE, WINDOW_SIZE }
