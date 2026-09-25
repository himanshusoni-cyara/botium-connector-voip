const { NamoDetector, DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION } = require('../namo-detector')
const { NamoTurnGate } = require('./namo-turn-gate')
const { PsstTurnHandler } = require('./psst-turn-handler')

class NamoTurnHandler {
  constructor (ctx) {
    this.ctx = ctx
    this.namoEnabled = true
    this._psstFallback = null
    this._lastVadSpeechEndAt = null
    this.detector = new NamoDetector({
      modelId: ctx.caps[ctx.Capabilities.VOIP_NAMO_MODEL_ID] || DEFAULT_MODEL_ID,
      revision: ctx.caps[ctx.Capabilities.VOIP_NAMO_MODEL_REVISION] || DEFAULT_MODEL_REVISION,
      modelPath: ctx.caps[ctx.Capabilities.VOIP_NAMO_MODEL_PATH] || null,
      cacheDir: ctx.caps[ctx.Capabilities.VOIP_NAMO_CACHE_DIR] || process.env.BOTIUM_NAMO_CACHE_DIR,
      log: (event, data) => ctx._info(event, { sessionId: ctx.sessionId, ...data })
    })
    this.gate = new NamoTurnGate({
      caps: ctx.caps,
      Capabilities: ctx.Capabilities,
      detector: this.detector,
      getMessages: () => ctx.botMsgs,
      commitFlush: (message) => ctx.commitNamoFlush(message),
      getVadSpeechActive: () => !!(ctx.inboundLane && ctx.inboundLane.speechActive),
      getVadEnabled: () => {
        const off = ctx.caps[ctx.Capabilities.VOIP_NAMO_VAD_ENABLE] === false ||
          ctx.caps[ctx.Capabilities.VOIP_NAMO_VAD_ENABLE] === 'false'
        return !off && !!(ctx.inboundLane && !ctx.inboundLane._loadError)
      },
      getLastVadSpeechEndAt: () => this._lastVadSpeechEndAt,
      setLastVadSpeechEndAt: (v) => { this._lastVadSpeechEndAt = v },
      eventEmitter: ctx.eventEmitter,
      sessionId: ctx.sessionId,
      _info: (event, data) => ctx._info(event, { sessionId: ctx.sessionId, ...data }),
      onInferenceError: (err) => this._onInferenceError(err)
    })
  }

  get silenceTimerActive () {
    if (!this.namoEnabled) {
      return this._getPsstFallback().silenceTimerActive
    }
    return this.gate.timersActive
  }

  async init () {
    if (!this.namoEnabled) return
    try {
      await this.detector.init()
      const { caps, Capabilities, _info, sessionId } = this.ctx
      _info('namo_mode_enabled', {
        sessionId,
        threshold: this.gate.threshold,
        reopenMs: this.gate.reopenMs,
        maxWaitMs: this.gate.maxWaitMs,
        vadEnabled: this.gate.vadEnabled,
        modelId: caps[Capabilities.VOIP_NAMO_MODEL_ID] || DEFAULT_MODEL_ID
      })
    } catch (err) {
      this._enablePsstFallback('initialization', err)
    }
  }

  _getPsstFallback () {
    if (!this._psstFallback) {
      this._psstFallback = new PsstTurnHandler(this.ctx)
    }
    return this._psstFallback
  }

  _enablePsstFallback (phase, err) {
    const { caps, Capabilities, _info, sessionId } = this.ctx
    const fallbackHandling = caps[Capabilities.VOIP_NAMO_FALLBACK_HANDLING] || 'PSST'
    this.namoEnabled = false
    this.gate.reset()
    _info('namo_model_error', {
      sessionId,
      phase,
      error: err && err.message,
      action: 'fallback',
      fallbackHandling
    })
  }

  _onInferenceError (err) {
    this._enablePsstFallback('inference', err)
    if (this.ctx.botMsgs && this.ctx.botMsgs.length > 0) {
      this._getPsstFallback().onFinalBuffered()
    }
  }

  shouldSuppressSttFinal (text) {
    if (!this.namoEnabled) return false
    if (this.gate.shouldSuppressSttText(text)) {
      this.ctx._info('namo_dtmf_echo_suppressed', {
        sessionId: this.ctx.sessionId,
        preview: String(text).substring(0, 160)
      })
      return true
    }
    return false
  }

  noteAgentDtmf () {
    if (this.namoEnabled) this.gate.noteAgentDtmf()
  }

  onInboundVadSpeechStart () {
    if (this.namoEnabled) this.gate.onVadSpeechStart()
  }

  onInboundVadSpeechEnd () {
    if (this.namoEnabled) this.gate.onVadSpeechEnd()
  }

  onFinalBuffered () {
    if (!this.namoEnabled) {
      this._getPsstFallback().onFinalBuffered()
      return
    }
    this.gate.onFinalBuffered()
  }

  onSpeechResumed (withinCap) {
    if (!this.namoEnabled) {
      if (withinCap) this._getPsstFallback().onSpeechResumed(withinCap)
      return
    }
    if (withinCap) this.gate.onSpeechResumed()
  }

  onPartialNewUtterance () {
    if (!this.namoEnabled) {
      this._getPsstFallback().onPartialNewUtterance()
    }
  }

  forceFlush (reason) {
    if (this.namoEnabled) {
      this.gate.forceFlush(reason)
    } else if (this.ctx.botMsgs && this.ctx.botMsgs.length > 0) {
      this.ctx.flushBufferedBotMsgs()
    }
  }

  clearTimer (reason) {
    if (!this.namoEnabled) {
      this._getPsstFallback().clearTimer(reason)
      return
    }
    this.gate.clearTimers()
  }

  reset () {
    if (!this.namoEnabled) {
      this._getPsstFallback().reset()
      return
    }
    this.gate.reset()
  }

  onAudioChunk () {}
}

module.exports = { NamoTurnHandler }
