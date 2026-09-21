const ort = require('onnxruntime-node')
const { parseTenVadMetadata } = require('./ten-vad-model')
const { buildTenVadMelBanks, applyMelBanks } = require('./ten-vad-mel')
const { rfftKaldi1024 } = require('./ten-vad-rfft')

const SAMPLE_RATE = 16000
const WINDOW_SIZE = 256
const N_FFT = 1024
const LOG_SCALE = 20.79441541679836 // log(32768^2)
const PREEMPHASIS = 0.97

let sharedMelBanks = null

const getMelBanks = () => {
  if (!sharedMelBanks) sharedMelBanks = buildTenVadMelBanks()
  return sharedMelBanks
}

const computePowerSpectrum = (fftBins, n, out) => {
  out[0] = fftBins[0] * fftBins[0]
  out[n - 1] = fftBins[1] * fftBins[1]
  for (let i = 1; i < n / 2; i++) {
    const real = fftBins[2 * i]
    const imag = fftBins[2 * i + 1]
    out[i] = real * real + imag * imag
  }
}

const logMel = (features, n) => {
  for (let i = 0; i < n; i++) {
    features[i] = Math.log(features[i] + 1e-10) - LOG_SCALE
  }
}

class TenVadEngine {
  constructor ({
    modelPath,
    threshold = 0.5,
    minSilenceMs = 280,
    minSpeechMs = 250,
    windowSize = WINDOW_SIZE
  }) {
    this.modelPath = modelPath
    this.threshold = threshold
    this.windowSize = windowSize
    this.minSilenceSamples = Math.round((minSilenceMs / 1000) * SAMPLE_RATE)
    this.minSpeechSamples = Math.round((minSpeechMs / 1000) * SAMPLE_RATE)

    this._session = null
    this._inputNames = null
    this._outputNames = null
    this._mean = null
    this._invStddev = null
    this._window = null
    this._states = null

    this._triggered = false
    this._currentSample = 0
    this._tempStart = 0
    this._tempEnd = 0
    this._lastSample = 0

    this._features = new Float32Array(41)
    this._lastFeatures = new Float32Array(3 * 41)
    this._tmpSamples = new Float32Array(N_FFT)
    this._powerSpectrum = new Float32Array(N_FFT)
    this._melOut = new Float32Array(40)
  }

  static async create (options) {
    const engine = new TenVadEngine(options)
    await engine._load()
    return engine
  }

  async _load () {
    const meta = parseTenVadMetadata(this.modelPath)
    this._mean = meta.mean
    this._invStddev = meta.invStddev
    this._window = meta.window

    this._session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu']
    })
    this._inputNames = this._session.inputNames
    this._outputNames = this._session.outputNames
    this.reset()
  }

  reset () {
    this._triggered = false
    this._currentSample = 0
    this._tempStart = 0
    this._tempEnd = 0
    this._lastSample = 0
    this._lastFeatures.fill(0)
    this._tmpSamples.fill(0)
    this._resetStates()
  }

  _resetStates () {
    this._states = []
    for (let i = 0; i < 4; i++) {
      this._states.push(new ort.Tensor('float32', new Float32Array(64), [1, 64]))
    }
  }

  _scale (samples, n, out) {
    const kScale = 32768.0
    for (let i = 0; i < n; i++) out[i] = samples[i] * kScale
  }

  _preemphasis (samples, n, out) {
    const t = samples[n - 1]
    for (let i = n - 1; i > 0; i--) {
      out[i] = samples[i] - PREEMPHASIS * samples[i - 1]
    }
    out[0] = samples[0] - PREEMPHASIS * this._lastSample
    this._lastSample = t
  }

  _applyWindow (samples, n, out) {
    for (let i = 0; i < n; i++) out[i] = samples[i] * this._window[i]
  }

  _applyNormalization (features) {
    for (let i = 0; i < 41; i++) {
      features[i] = (features[i] - this._mean[i]) * this._invStddev[i]
    }
  }

  _rollFeatures () {
    const row = 41
    this._lastFeatures.copyWithin(0, row, 3 * row)
    this._lastFeatures.set(this._features, 2 * row)
  }

  _computeFeatures (samples, n) {
    this._tmpSamples.fill(0)
    this._scale(samples, n, this._tmpSamples)
    this._preemphasis(this._tmpSamples, n, this._tmpSamples)
    this._applyWindow(this._tmpSamples, n, this._tmpSamples)
    rfftKaldi1024(this._tmpSamples)
    computePowerSpectrum(this._tmpSamples, N_FFT, this._powerSpectrum)
    applyMelBanks(getMelBanks(), this._powerSpectrum, this._melOut)
    this._features.set(this._melOut)
    this._features[40] = 0
    logMel(this._features, 40)
    this._applyNormalization(this._features)
    this._rollFeatures()
  }

  async _run (samples, n) {
    this._computeFeatures(samples, n)

    const x = new ort.Tensor('float32', this._lastFeatures, [1, 3, 41])
    const feeds = {}
    feeds[this._inputNames[0]] = x
    for (let i = 0; i < this._states.length; i++) {
      feeds[this._inputNames[i + 1]] = this._states[i]
    }

    const out = await this._session.run(feeds)
    const prob = out[this._outputNames[0]].data[0]
    for (let i = 0; i < this._states.length; i++) {
      this._states[i] = out[this._outputNames[i + 1]]
    }
    return prob
  }

  /**
   * Sherpa ten-vad IsSpeech hysteresis (one window = windowSize samples @ 16 kHz).
   * @returns {Promise<boolean>}
   */
  async isSpeech (samples) {
    const n = samples.length
    if (n !== this.windowSize) {
      throw new Error(`ten-vad window size ${n} != ${this.windowSize}`)
    }
    const prob = await this._run(samples, n)
    const threshold = this.threshold

    this._currentSample += this.windowSize

    if (prob > threshold && this._tempEnd !== 0) {
      this._tempEnd = 0
    }

    if (prob > threshold && this._tempStart === 0) {
      this._tempStart = this._currentSample
      return false
    }

    if (prob > threshold && this._tempStart !== 0 && !this._triggered) {
      if (this._currentSample - this._tempStart < this.minSpeechSamples) {
        return false
      }
      this._triggered = true
      return true
    }

    if (prob < threshold && !this._triggered) {
      this._tempStart = 0
      this._tempEnd = 0
      return false
    }

    if (prob > threshold - 0.15 && this._triggered) {
      return true
    }

    if (prob > threshold && !this._triggered) {
      this._triggered = true
      return true
    }

    if (prob < threshold && this._triggered) {
      if (this._tempEnd === 0) {
        this._tempEnd = this._currentSample
      }
      if (this._currentSample - this._tempEnd < this.minSilenceSamples) {
        return true
      }
      this._tempStart = 0
      this._tempEnd = 0
      this._triggered = false
      return false
    }

    return false
  }

  /**
   * @returns {Promise<{ speech: boolean, pause: boolean }>}
   */
  async processWindow (samples) {
    const wasTriggered = this._triggered
    const speech = await this.isSpeech(samples)
    const pause = wasTriggered && !this._triggered
    return { speech, pause }
  }
}

module.exports = {
  TenVadEngine,
  SAMPLE_RATE,
  WINDOW_SIZE
}
