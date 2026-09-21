const fs = require('fs')
const _ = require('lodash')
const { RmsVad } = require('./rms-vad')
const { getTurnAudioFloat32, recordingSecNow } = require('./turn-audio')
const { defaultCachePath, configuredOverridePath } = require('./smart-turn-model')

const DEFAULT_MIN_COMMIT_DELAY_MS = 300

let smartTurnModule = null
let smartTurnOptionsSet = false

const loadSmartTurn = () => {
  if (smartTurnModule) return smartTurnModule
  try {
    smartTurnModule = require('@micdrop/smart-turn')
    return smartTurnModule
  } catch (err) {
    return null
  }
}

const ensureSmartTurnModel = (modelPath) => {
  if (!modelPath) return false
  try {
    const { setSmartTurnOptions } = require('@micdrop/smart-turn/node')
    if (!smartTurnOptionsSet) {
      setSmartTurnOptions({ model: modelPath })
      smartTurnOptionsSet = true
    }
    return true
  } catch (err) {
    return false
  }
}

class SmartTurnHandler {
  constructor (ctx) {
    this.ctx = ctx
    this._psstFallback = null
    this._vad = null
    this._smartTurn = null
    this._initError = null
    this._maxSilenceTimer = null
    this._commitTimer = null
    this._pauseStartedAt = null
    this._evaluating = false
    this._pendingCommitReason = null
    this.silenceTimeout = null
    this._init()
  }

  _init () {
    const { caps, Capabilities, _info, sessionId } = this.ctx
    const modelPath = caps[Capabilities.VOIP_SMART_TURN_MODEL_PATH] ||
      configuredOverridePath(caps, Capabilities) ||
      (fs.existsSync(defaultCachePath()) ? defaultCachePath() : null)
    const mod = loadSmartTurn()
    if (!mod || !ensureSmartTurnModel(modelPath)) {
      this._initError = 'smart_turn_unavailable'
      _info('smart_turn_fallback_psst', { sessionId, reason: this._initError })
      return
    }
    const threshold = parseFloat(caps[Capabilities.VOIP_SMART_TURN_THRESHOLD])
    this._smartTurn = new mod.SmartTurn({ threshold: _.isFinite(threshold) ? threshold : 0.5 })
    const minSilence = parseInt(caps[Capabilities.VOIP_SMART_TURN_VAD_MIN_SILENCE_MS], 10)
    this._vad = new RmsVad({ minSilenceMs: _.isFinite(minSilence) && minSilence > 0 ? minSilence : 280 })
    this._vad.onPause(() => this._onVadPause())
  }

  get silenceTimerActive () {
    return !!(this.silenceTimeout || this._maxSilenceTimer || this._commitTimer)
  }

  _getPsstFallback () {
    if (!this._psstFallback) {
      const { PsstTurnHandler } = require('./psst-turn-handler')
      this._psstFallback = new PsstTurnHandler(this.ctx)
    }
    return this._psstFallback
  }

  _fallbackToPsst (reason) {
    const { _info, sessionId } = this.ctx
    _info('smart_turn_fallback_psst', { sessionId, reason })
    this.reset()
    this._getPsstFallback().onFinalBuffered()
  }

  _maxSilenceMs () {
    const { caps, Capabilities, convoStep, botMsgs } = this.ctx
    const configured = parseInt(caps[Capabilities.VOIP_SMART_TURN_MAX_SILENCE_MS], 10)
    const capMs = _.isFinite(configured) && configured > 0 ? configured : 2000
    const joinTimeoutMs = this.ctx.getEffectiveJoinTimeoutMs(convoStep, botMsgs)
    const graceMs = this.ctx.getPsstLatencyGraceMs()
    const graceApplied = graceMs > 0 && _.isFinite(joinTimeoutMs) && joinTimeoutMs > 0 && !this.ctx.isLastFinalNaturalEnd()
    const effectiveJoin = graceApplied ? (joinTimeoutMs + graceMs) : (joinTimeoutMs || 0)
    if (_.isFinite(effectiveJoin) && effectiveJoin > 0) {
      return Math.min(capMs, effectiveJoin)
    }
    return capMs
  }

  _armObservability (maxSilenceMs) {
    const { sessionId, eventEmitter, botMsgs, markReplyTrace, _info } = this.ctx
    const bufferedAtArm = (botMsgs && botMsgs.length) || 0
    const armedAt = Date.now()
    markReplyTrace({ psstTimerArmedAtMs: armedAt, psstScheduledMs: maxSilenceMs, turnHandler: 'SMART_TURN' })
    _info('psst_timer_armed', {
      sessionId,
      joinTimeoutMs: maxSilenceMs,
      baseTimeoutMs: maxSilenceMs,
      graceMs: 0,
      graceApplied: false,
      bufferedChunks: bufferedAtArm,
      stopCalled: !!this.ctx.stopCalled,
      turnHandler: 'SMART_TURN'
    })
    if (eventEmitter && maxSilenceMs > 0) {
      try {
        eventEmitter.emit('voip.psstTimerArmed', {
          sessionId,
          joinTimeoutMs: maxSilenceMs,
          bufferedChunks: bufferedAtArm,
          armedAt
        })
      } catch (err) { /* ignore */ }
    }
  }

  clearTimer (reason) {
    if (this._maxSilenceTimer) {
      clearTimeout(this._maxSilenceTimer)
      this._maxSilenceTimer = null
    }
    if (this._commitTimer) {
      clearTimeout(this._commitTimer)
      this._commitTimer = null
    }
    this.silenceTimeout = null
    if (reason) {
      this.ctx._info('psst_timer_cleared', {
        sessionId: this.ctx.sessionId,
        reason,
        bufferedChunks: (this.ctx.botMsgs && this.ctx.botMsgs.length) || 0,
        turnHandler: 'SMART_TURN'
      })
    }
  }

  reset () {
    this.clearTimer(null)
    this._pauseStartedAt = null
    this._evaluating = false
    if (this._vad) this._vad.reset()
  }

  onFinalBuffered () {
    if (this._initError) {
      this._getPsstFallback().onFinalBuffered()
      return
    }
    if (!this.ctx.isJoinMethod()) return
    if (!this.ctx.botMsgs || this.ctx.botMsgs.length === 0) return

    this.clearTimer(null)
    const maxSilenceMs = this._maxSilenceMs()
    this._armObservability(maxSilenceMs)
    this._pauseStartedAt = null
    if (this._vad) this._vad.reset()

    this._maxSilenceTimer = setTimeout(() => {
      this._maxSilenceTimer = null
      this.ctx._info('smart_turn_max_silence', { sessionId: this.ctx.sessionId, maxSilenceMs })
      this._commit('smart_turn_max_silence')
    }, maxSilenceMs)

    // Also evaluate after final in case VAD already sees trailing silence.
    setTimeout(() => this._onVadPause(), 0)
  }

  onSpeechResumed (withinCap) {
    if (this._initError) {
      this._getPsstFallback().onSpeechResumed(withinCap)
      return
    }
    this.clearTimer('speech_resumed')
    this._pauseStartedAt = null
    this._evaluating = false
    if (this._vad) this._vad.reset()
    if (withinCap && this.ctx.botMsgs && this.ctx.botMsgs.length > 0) {
      this.onFinalBuffered()
    }
  }

  onPartialNewUtterance () {
    if (this._initError) {
      this._getPsstFallback().onPartialNewUtterance()
      return
    }
    this.onFinalBuffered()
  }

  onAudioChunk (pcmChunk, format) {
    if (this._initError || !this._vad || !pcmChunk || !format) return
    if (!this.ctx.botMsgs || this.ctx.botMsgs.length === 0) return
    this._vad.feedPcm16(pcmChunk, format.sampleRate, format.channels || 1)
  }

  async _onVadPause () {
    if (this._initError || this._evaluating) return
    if (!this.ctx.botMsgs || this.ctx.botMsgs.length === 0) return
    if (!this._smartTurn) return

    this._evaluating = true
    const { sessionId, _info, audioStream, botMsgs, markReplyTrace, caps, Capabilities } = this.ctx
    if (!this._pauseStartedAt) this._pauseStartedAt = Date.now()
    _info('smart_turn_vad_pause', { sessionId, bufferedChunks: botMsgs.length })

    const endSec = recordingSecNow(audioStream)
    const audio = getTurnAudioFloat32(audioStream, botMsgs, endSec)
    if (!audio || !audio.samples || audio.samples.length === 0) {
      this._evaluating = false
      return
    }

    const timeoutMs = parseInt(caps[Capabilities.VOIP_SMART_TURN_INFERENCE_TIMEOUT_MS], 10)
    const inferTimeout = _.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1000

    try {
      const result = await Promise.race([
        this._smartTurn.predictOnce(audio.samples, audio.sampleRate),
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('timeout')), inferTimeout)
        })
      ])
      const complete = !!(result && result.complete)
      const probability = result && (result.probability ?? result.score)
      markReplyTrace({
        smartTurnComplete: complete,
        smartTurnProbability: _.isFinite(probability) ? probability : null,
        turnHandler: 'SMART_TURN'
      })
      _info('smart_turn_prediction', {
        sessionId,
        complete,
        probability: _.isFinite(probability) ? probability : null,
        sampleRate: audio.sampleRate,
        samples: audio.samples.length
      })
      if (complete) {
        const minDelay = parseInt(caps[Capabilities.VOIP_SMART_TURN_MIN_COMMIT_DELAY_MS], 10)
        const delayMs = _.isFinite(minDelay) && minDelay >= 0 ? minDelay : DEFAULT_MIN_COMMIT_DELAY_MS
        if (this._commitTimer) clearTimeout(this._commitTimer)
        this._commitTimer = setTimeout(() => {
          this._commitTimer = null
          this._commit('smart_turn_complete')
        }, delayMs)
      }
    } catch (err) {
      _info('smart_turn_fallback_psst', { sessionId, reason: err.message || 'inference_failed' })
      this._evaluating = false
      this._fallbackToPsst('inference_failed')
      return
    }
    this._evaluating = false
  }

  _commit (reason) {
    if (!this.ctx.botMsgs || this.ctx.botMsgs.length === 0) return
    this.clearTimer(null)
    this.ctx._info('smart_turn_commit', {
      sessionId: this.ctx.sessionId,
      reason,
      bufferedChunks: this.ctx.botMsgs.length
    })
    this.ctx.markReplyTrace({ psstTimerFiredAtMs: Date.now(), turnHandler: 'SMART_TURN' })
    this.ctx.flushBufferedBotMsgs()
  }
}

module.exports = { SmartTurnHandler, loadSmartTurn, ensureSmartTurnModel }
