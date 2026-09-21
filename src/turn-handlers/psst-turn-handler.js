const _ = require('lodash')

class PsstTurnHandler {
  constructor (ctx) {
    this.ctx = ctx
    this.silenceTimeout = null
  }

  get silenceTimerActive () {
    return !!this.silenceTimeout
  }

  clearTimer (reason) {
    const { sessionId, _info, botMsgs } = this.ctx
    if (this.silenceTimeout) {
      if (reason) {
        _info('psst_timer_cleared', {
          sessionId,
          reason,
          bufferedChunks: (botMsgs && botMsgs.length) || 0
        })
      }
      clearTimeout(this.silenceTimeout)
      this.silenceTimeout = null
    }
  }

  reset () {
    this.clearTimer(null)
  }

  armJoinSilenceTimer () {
    const ctx = this.ctx
    const { botMsgs, caps, convoStep, sessionId, eventEmitter, _info, debug } = ctx
    if (!botMsgs || botMsgs.length === 0) return
    if (!ctx.isJoinMethod()) return

    const joinTimeoutMs = ctx.getEffectiveJoinTimeoutMs(convoStep, botMsgs)
    const graceMs = ctx.getPsstLatencyGraceMs()
    const graceApplied = graceMs > 0 && _.isFinite(joinTimeoutMs) && joinTimeoutMs > 0 && !ctx.isLastFinalNaturalEnd()
    const effectiveWindowMs = graceApplied ? (joinTimeoutMs + graceMs) : (joinTimeoutMs || 0)

    this.clearTimer(null)
    const bufferedAtArm = botMsgs.length
    const armedAt = Date.now()
    ctx.markReplyTrace({ psstTimerArmedAtMs: armedAt, psstScheduledMs: effectiveWindowMs || 0, turnHandler: 'PSST' })
    _info('psst_timer_armed', {
      sessionId,
      joinTimeoutMs: effectiveWindowMs || 0,
      baseTimeoutMs: joinTimeoutMs || 0,
      graceMs: graceApplied ? graceMs : 0,
      graceApplied,
      bufferedChunks: bufferedAtArm,
      stopCalled: !!ctx.stopCalled
    })
    if (eventEmitter && _.isFinite(effectiveWindowMs) && effectiveWindowMs > 0) {
      try {
        eventEmitter.emit('voip.psstTimerArmed', {
          sessionId,
          joinTimeoutMs: effectiveWindowMs,
          bufferedChunks: bufferedAtArm,
          armedAt
        })
      } catch (emitErr) {
        debug(`voip.psstTimerArmed emission failed: ${emitErr && emitErr.message}`)
      }
    }
    this.silenceTimeout = setTimeout(() => {
      const fireDelay = Date.now() - armedAt
      ctx.markReplyTrace({ psstTimerFiredAtMs: Date.now(), psstFireDelayMs: fireDelay })
      if (ctx.botMsgs.length > 0) {
        _info('psst_timer_fired', {
          sessionId,
          bufferedChunks: ctx.botMsgs.length,
          actualDelayMs: fireDelay,
          scheduledDelayMs: effectiveWindowMs || 0,
          graceApplied,
          outcome: 'emit'
        })
        debug('Silence Duration Timeout (JOIN/PSST):', effectiveWindowMs, 'ms')
        ctx.flushBufferedBotMsgs()
      } else {
        _info('psst_timer_fired', {
          sessionId,
          bufferedChunks: 0,
          actualDelayMs: fireDelay,
          scheduledDelayMs: effectiveWindowMs || 0,
          outcome: 'noop_empty_buffer'
        })
      }
    }, effectiveWindowMs || 0)
  }

  onFinalBuffered () {
    this.armJoinSilenceTimer()
  }

  onSpeechResumed (withinCap) {
    if (withinCap) this.armJoinSilenceTimer()
  }

  onPartialNewUtterance () {
    this.armJoinSilenceTimer()
  }

  onAudioChunk () {}
}

module.exports = { PsstTurnHandler }
