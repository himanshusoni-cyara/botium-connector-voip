const ort = require('onnxruntime-node')
const { loadLabelIndex, bundledLabelsPath } = require('./ced-tiny-model')
const { computeCedFeats } = require('./ced-tiny-features')
const { SAMPLE_RATE } = require('../inbound/inbound-lane')

const AVERAGE_LABELS = 527

class InboundSceneClassifier {
  constructor ({
    modelPath,
    enabled,
    speechProbMin = 0.35,
    musicProbMin = 0.45,
    eventEmitter,
    sessionId,
    _info
  }) {
    this._modelPath = modelPath
    this._enabled = enabled && modelPath
    this._speechProbMin = speechProbMin
    this._musicProbMin = musicProbMin
    this._eventEmitter = eventEmitter
    this._sessionId = sessionId
    this._info = _info || (() => {})
    this._session = null
    this._inputName = null
    this._labels = loadLabelIndex(bundledLabelsPath())
    this._scene = 'unknown'
    this._musicDominant = false
    this._lastRunAt = 0
    this._intervalMs = 450
    this._inFlight = false
  }

  getScene () {
    return this._scene
  }

  isMusicDominant () {
    return this._musicDominant
  }

  async _ensureSession () {
    if (this._session || !this._enabled) return
    this._session = await ort.InferenceSession.create(this._modelPath, {
      executionProviders: ['cpu']
    })
    this._inputName = this._session.inputNames[0]
  }

  _emitScene (scene) {
    if (!this._eventEmitter) return
    const kind = scene === 'music' ? 'scene_music' : (scene === 'speech' ? 'scene_speech' : 'scene_unknown')
    try {
      this._eventEmitter.emit('voip.botActivity', { sessionId: this._sessionId, kind })
      this._eventEmitter.emit('voip.inboundScene', { sessionId: this._sessionId, scene })
    } catch (err) { /* ignore */ }
  }

  async classifyWindow (float32Window) {
    if (!this._enabled || !float32Window || float32Window.length < SAMPLE_RATE / 2) return
    const now = Date.now()
    if (now - this._lastRunAt < this._intervalMs || this._inFlight) return
    this._lastRunAt = now
    this._inFlight = true
    try {
      await this._ensureSession()
      if (!this._session) return
      const input = new Float32Array(SAMPLE_RATE)
      const src = float32Window.length >= SAMPLE_RATE
        ? float32Window.subarray(float32Window.length - SAMPLE_RATE)
        : float32Window
      input.set(src, SAMPLE_RATE - src.length)
      const feats = computeCedFeats(input)
      if (!feats) return
      const tensor = new ort.Tensor('float32', feats.data, feats.dims)
      const out = await this._session.run({ [this._inputName]: tensor })
      const logits = out[this._session.outputNames[0]].data
      const speechIdx = this._labels.speech
      const musicIdx = this._labels.music
      let speechProb = 0
      let musicProb = 0
      if (logits.length >= AVERAGE_LABELS) {
        let max = -Infinity
        for (let i = 0; i < logits.length; i++) {
          if (logits[i] > max) max = logits[i]
        }
        let sum = 0
        let speechExp = 0
        let musicExp = 0
        for (let i = 0; i < logits.length; i++) {
          const e = Math.exp(logits[i] - max)
          sum += e
          if (i === speechIdx) speechExp = e
          if (i === musicIdx) musicExp = e
        }
        speechProb = speechExp / sum
        musicProb = musicExp / sum
      } else if (logits.length > Math.max(speechIdx, musicIdx)) {
        speechProb = logits[speechIdx]
        musicProb = logits[musicIdx]
      }
      let scene = 'unknown'
      if (musicProb >= this._musicProbMin && musicProb > speechProb) {
        scene = 'music'
      } else if (speechProb >= this._speechProbMin) {
        scene = 'speech'
      }
      this._musicDominant = scene === 'music'
      if (scene !== this._scene) {
        this._scene = scene
        this._emitScene(scene)
      }
    } catch (err) {
      this._info('ced_tiny_classify_error', { sessionId: this._sessionId, error: err.message })
    } finally {
      this._inFlight = false
    }
  }
}

module.exports = { InboundSceneClassifier }
