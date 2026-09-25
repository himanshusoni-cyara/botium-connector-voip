const DIGIT_ONLY_RE = /^[\d\s.,#-]+$/
const TURN_BUFFERING = 'buffering'
const TURN_SOFT_ENDED = 'soft_ended'
const DEFAULT_MEDIAN_GAP_MS = 400
const MAX_GAP_SAMPLES = 12
const HANDLING_NAMO = 'NAMO'

const numberCapability = (caps, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(caps[name])
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

const booleanCapability = (caps, name, fallback = false) => {
  const value = caps[name]
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  return fallback
}

const sourceDataParts = message => {
  if (!message || message.sourceData == null) return []
  return Array.isArray(message.sourceData) ? message.sourceData : [message.sourceData]
}

class NamoTurnGate {
  constructor ({
    caps,
    Capabilities,
    detector,
    getMessages,
    commitFlush,
    getVadSpeechActive,
    getVadEnabled,
    getLastVadSpeechEndAt,
    setLastVadSpeechEndAt,
    eventEmitter,
    sessionId,
    _info,
    onInferenceError
  }) {
    this.caps = caps
    this.Capabilities = Capabilities
    this.detector = detector
    this._getMessages = getMessages
    this._commitFlush = commitFlush
    this._getVadSpeechActive = getVadSpeechActive
    this._getVadEnabled = getVadEnabled
    this._getLastVadSpeechEndAt = getLastVadSpeechEndAt
    this._setLastVadSpeechEndAt = setLastVadSpeechEndAt
    this.eventEmitter = eventEmitter
    this.sessionId = sessionId
    this._info = _info
    this._onInferenceError = onInferenceError

    this.threshold = numberCapability(caps, Capabilities.VOIP_NAMO_EOU_THRESHOLD, 0.85, { min: 0, max: 1 })
    this.minWaitMs = numberCapability(caps, Capabilities.VOIP_NAMO_MIN_WAIT_MS, 250, { min: 0 })
    this.maxWaitMs = numberCapability(caps, Capabilities.VOIP_NAMO_MAX_WAIT_MS, 8000, { min: 1 })
    this.questionFlushMs = numberCapability(caps, Capabilities.VOIP_NAMO_QUESTION_FLUSH_MS, 2000, { min: 0 })
    this.emitStableMs = numberCapability(caps, Capabilities.VOIP_NAMO_EMIT_STABLE_MS, 600, { min: 0 })
    this.gapOutlierFactor = numberCapability(caps, Capabilities.VOIP_NAMO_GAP_OUTLIER_FACTOR, 2.5, { min: 1 })
    this.reopenMs = numberCapability(caps, Capabilities.VOIP_NAMO_REOPEN_MS, 800, { min: 0 })
    this.dtmfEchoMs = numberCapability(caps, Capabilities.VOIP_NAMO_DTMF_ECHO_MS, 600, { min: 0 })
    this.shortSegmentMergeMs = numberCapability(caps, Capabilities.VOIP_NAMO_VAD_SHORT_SEGMENT_MERGE_MS, 250, { min: 0 })
    this.delimiter = caps[Capabilities.VOIP_STT_MESSAGE_HANDLING_DELIMITER] || '. '
    this.vadEnabled = booleanCapability(caps, Capabilities.VOIP_NAMO_VAD_ENABLE, true)

    this.pendingStartedAt = null
    this.candidateVersion = 0
    this.decisionTimer = null
    this.maxWaitTimer = null
    this.questionFlushTimer = null
    this.emitStableTimer = null
    this.emitStableVersion = 0
    this.reopenTimer = null
    this.finalGaps = []
    this.lastFinalAt = null
    this.lastCommittedAt = null
    this.lastAgentDtmfAt = null
    this.turnId = 1
    this.revision = 0
    this.turnState = null
    this.decisionChain = Promise.resolve()
    this.pendingVadFlush = false
    this.pendingVadResult = null
    this.pendingVadReason = null
  }

  get _messages () { return this._getMessages() || [] }

  noteAgentDtmf () {
    this.lastAgentDtmfAt = Date.now()
    this._info('namo_agent_dtmf', { sessionId: this.sessionId, echoWindowMs: this.dtmfEchoMs })
  }

  shouldSuppressSttText (text) {
    if (this.dtmfEchoMs <= 0 || this.lastAgentDtmfAt == null) return false
    if (Date.now() - this.lastAgentDtmfAt >= this.dtmfEchoMs) return false
    const trimmed = String(text || '').trim()
    return trimmed.length > 0 && DIGIT_ONLY_RE.test(trimmed)
  }

  onVadSpeechStart () {
    this._info('namo_vad_speech_start', {
      sessionId: this.sessionId,
      bufferedChunks: this._messages.length,
      turnState: this.turnState,
      pendingVadFlush: this.pendingVadFlush
    })
    this._clearEmitStableTimer()
    if (!this._messages.length) return
    if (this.turnState === TURN_SOFT_ENDED) {
      this._reopenTurn('vad_speech_start')
      return
    }
    this._clearQuestionFlushTimer()
    this._clearReopenTimer()
    if (this.pendingStartedAt != null) this._armMaxWaitTimer()
  }

  onVadSpeechEnd () {
    const now = Date.now()
    const previousEndAt = this._getLastVadSpeechEndAt()
    this._setLastVadSpeechEndAt(now)
    this._info('namo_vad_speech_end', {
      sessionId: this.sessionId,
      bufferedChunks: this._messages.length,
      turnState: this.turnState,
      pendingVadFlush: this.pendingVadFlush
    })
    if (
      this._messages.length &&
      this.turnState &&
      this.shortSegmentMergeMs > 0 &&
      previousEndAt != null &&
      now - previousEndAt < this.shortSegmentMergeMs
    ) {
      this._reopenTurn('vad_short_segment_merge')
      return
    }
    if (this.pendingVadFlush) {
      const result = this.pendingVadResult
      const reason = this.pendingVadReason || 'model_complete_vad'
      this.pendingVadFlush = false
      this._softEndTurn(reason, result)
      return
    }
    if (this._messages.length) {
      this._armEmitStableTimer()
      this.decisionChain = this.decisionChain
        .then(() => this._scheduleDecision())
        .catch(err => this._onInferenceError(err))
    }
  }

  onSpeechResumed () {
    if (this.turnState === TURN_SOFT_ENDED && this._messages.length) {
      this._reopenTurn('speech_resumed')
    }
  }

  onFinalBuffered () {
    const gapMs = this._recordFinalGap()
    if (this.turnState === TURN_SOFT_ENDED) this._reopenTurn('stt_final')
    this._maybeSplitOnOutlierGap(gapMs)
    this._openTurnIfNeeded()
    this.candidateVersion++
    if (this.pendingStartedAt == null) {
      this.pendingStartedAt = Date.now()
      this._armMaxWaitTimer()
    }
    const text = this._joinedText()
    this._info('namo_candidate_received', {
      sessionId: this.sessionId,
      candidateVersion: this.candidateVersion,
      turnId: this.turnId,
      revision: this.revision,
      turnState: this.turnState,
      bufferedChunks: this._messages.length,
      textLength: text.length,
      ...(gapMs != null ? { gapMs, medianGapMs: Number(this._medianGapMs().toFixed(1)) } : {}),
      preview: text.substring(0, 160)
    })
    this._clearEmitStableTimer()
    this._scheduleDecision()
    this._armQuestionFlushTimer()
    this._armEmitStableTimer()
  }

  forceFlush (reason) {
    this._flushPending(reason || 'force_flush', null)
  }

  clearTimers () {
    this._clearDecisionTimer()
    this._clearMaxWaitTimer()
    this._clearQuestionFlushTimer()
    this._clearEmitStableTimer()
    this._clearReopenTimer()
  }

  reset () {
    this.clearTimers()
    this.turnState = null
    this.pendingVadFlush = false
    this.pendingVadResult = null
    this.pendingVadReason = null
  }

  get timersActive () {
    return !!(this.decisionTimer || this.maxWaitTimer || this.questionFlushTimer || this.emitStableTimer || this.reopenTimer)
  }

  _openTurnIfNeeded () {
    if (this.turnState) return
    this.turnState = TURN_BUFFERING
    this.revision = 0
  }

  _reopenTurn (reason) {
    if (!this._messages.length) return
    this.revision += 1
    this.turnState = TURN_BUFFERING
    this.pendingVadFlush = false
    this._clearReopenTimer()
    this._clearEmitStableTimer()
    this._clearQuestionFlushTimer()
    this._info('namo_turn_reopen', {
      reason,
      turnId: this.turnId,
      revision: this.revision,
      bufferedChunks: this._messages.length
    })
    if (this.pendingStartedAt != null) {
      this._armMaxWaitTimer()
    }
  }

  _softEndTurn (reason, result) {
    if (!this._messages.length) return
    if (!this._vadGateActive()) {
      this._flushPending(reason, result)
      return
    }
    if (this.turnState === TURN_SOFT_ENDED) {
      if (!this.reopenTimer) this._armReopenTimer()
      return
    }
    this.turnState = TURN_SOFT_ENDED
    this.pendingVadFlush = false
    this.pendingVadResult = result || this.pendingVadResult
    this.pendingVadReason = reason
    this._info('namo_turn_soft_end', {
      reason,
      turnId: this.turnId,
      revision: this.revision,
      reopenMs: this.reopenMs,
      bufferedChunks: this._messages.length
    })
    this._armReopenTimer()
  }

  _vadGateActive () {
    return this.vadEnabled && this._getVadEnabled()
  }

  _shouldHoldForVad () {
    return this._vadGateActive() && this._getVadSpeechActive()
  }

  _requestSemanticFlush (reason, result) {
    if (this._shouldHoldForVad()) {
      this.pendingVadFlush = true
      this.pendingVadResult = result
      this.pendingVadReason = reason === 'model_complete' ? 'model_complete_vad' : reason
      this.turnState = TURN_BUFFERING
      this._info('namo_vad_hold', {
        reason,
        bufferedChunks: this._messages.length,
        vadSpeechActive: true
      })
      return
    }
    if (this._vadGateActive()) {
      this._softEndTurn(reason === 'model_complete' ? 'model_complete' : reason, result)
      return
    }
    this._flushPending(reason, result)
  }

  _clearDecisionTimer () {
    if (this.decisionTimer) {
      clearTimeout(this.decisionTimer)
      this.decisionTimer = null
    }
  }

  _clearMaxWaitTimer () {
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
  }

  _clearQuestionFlushTimer () {
    if (this.questionFlushTimer) {
      clearTimeout(this.questionFlushTimer)
      this.questionFlushTimer = null
    }
  }

  _clearEmitStableTimer () {
    if (this.emitStableTimer) {
      clearTimeout(this.emitStableTimer)
      this.emitStableTimer = null
    }
    this.emitStableVersion++
  }

  _clearReopenTimer () {
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer)
      this.reopenTimer = null
    }
  }

  _armReopenTimer () {
    this._clearReopenTimer()
    if (!this._messages.length) return
    const delay = this.reopenMs
    const armedAt = Date.now()
    const finish = () => {
      this.reopenTimer = null
      if (this.turnState !== TURN_SOFT_ENDED || !this._messages.length) return
      if (this._shouldHoldForVad()) {
        this._info('namo_reopen_hold', { reason: 'vad_speech_active', turnId: this.turnId })
        return
      }
      this._info('namo_reopen_commit', {
        reopenMs: this.reopenMs,
        actualWaitMs: Date.now() - armedAt,
        turnId: this.turnId,
        revision: this.revision,
        bufferedChunks: this._messages.length
      })
      this._flushPending(this.pendingVadReason || 'model_complete', this.pendingVadResult)
    }
    if (delay <= 0) {
      finish()
      return
    }
    this.reopenTimer = setTimeout(finish, delay)
  }

  _medianGapMs () {
    if (!this.finalGaps.length) return DEFAULT_MEDIAN_GAP_MS
    const sorted = [...this.finalGaps].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
  }

  _isOutlierGap (gapMs) {
    if (!Number.isFinite(gapMs) || gapMs <= 0) return false
    if (this.emitStableMs > 0 && gapMs < this.emitStableMs) return false
    if (this.finalGaps.length < 2) return false
    return gapMs > this._medianGapMs() * this.gapOutlierFactor
  }

  _armEmitStableTimer () {
    if (this.emitStableMs <= 0 || !this._messages.length) return
    this._clearEmitStableTimer()
    const version = this.emitStableVersion
    const armedAt = Date.now()
    this.emitStableTimer = setTimeout(() => {
      if (version !== this.emitStableVersion) return
      this.emitStableTimer = null
      this.decisionChain = this.decisionChain
        .then(() => this._tryCohesionEmit(armedAt))
        .catch(err => this._handleInferenceError(err))
    }, this.emitStableMs)
  }

  _maybeSplitOnOutlierGap (gapMs) {
    if (this.turnState === TURN_BUFFERING || this.turnState === TURN_SOFT_ENDED) {
      return false
    }
    if (!this._isOutlierGap(gapMs)) return false
    // After a committed turn there is nothing left to flush. Record the outlier
    // so a large post-commit gap is treated as a new turn, not a split of the last one.
    this._info('namo_gap_outlier_new_turn', {
      gapMs,
      medianGapMs: Number(this._medianGapMs().toFixed(1)),
      gapOutlierFactor: this.gapOutlierFactor
    })
    return false
  }

  _recordFinalGap () {
    const now = Date.now()
    const referenceAt = this.turnState ? this.lastFinalAt : this.lastCommittedAt
    if (referenceAt != null && !this.turnState) {
      const gapFromCommit = now - this.lastCommittedAt
      this.lastFinalAt = now
      return gapFromCommit
    }
    if (this.lastFinalAt != null) {
      const gapMs = now - this.lastFinalAt
      this.finalGaps.push(gapMs)
      if (this.finalGaps.length > MAX_GAP_SAMPLES) {
        this.finalGaps.shift()
      }
      this.lastFinalAt = now
      return gapMs
    }
    this.lastFinalAt = now
    return null
  }

  _armQuestionFlushTimer () {
    this._clearQuestionFlushTimer()
    if (this.questionFlushMs <= 0 || !this._messages.length) return

    const joinedText = this._joinedText()
    const lastText = this._lastSegmentText()
    if (!this._looksLikeQuestionCandidate(joinedText, lastText)) return

    const elapsed = this.pendingStartedAt == null ? 0 : Date.now() - this.pendingStartedAt
    const remaining = Math.max(0, this.questionFlushMs - elapsed)
    const armedAt = Date.now()
    this.questionFlushTimer = setTimeout(() => {
      if (!this._messages.length) return
      const currentJoined = this._joinedText()
      const currentLast = this._lastSegmentText()
      if (!this._looksLikeQuestionCandidate(currentJoined, currentLast)) return
      this._info('namo_question_flush_fired', {
        questionFlushMs: this.questionFlushMs,
        actualWaitMs: Date.now() - armedAt,
        bufferedChunks: this._messages.length,
        preview: currentJoined.substring(0, 160)
      })
      this._requestSemanticFlush('question_heuristic')
    }, remaining)
  }

  _joinedText () {
    return this._messages.map(message => message.messageText).join(this.delimiter)
  }

  _lastSegmentText () {
    const last = this._messages[this._messages.length - 1]
    return last && typeof last.messageText === 'string' ? last.messageText.trim() : ''
  }

  _looksLikeQuestionSegment (text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return false
    if (/\?\s*$/.test(trimmed)) return true
    if (/\b(yes or no|say yes or no)\b/i.test(trimmed)) return true
    if (/\b(what you are calling about|how can i assist|what is the issue|which one do you want)\b/i.test(trimmed)) {
      return true
    }
    return false
  }

  _looksLikeQuestionCandidate (joinedText, lastSegmentText) {
    const joined = String(joinedText || '').trim()
    const last = String(lastSegmentText || '').trim()
    if (/\?\s*$/.test(joined)) return true
    return this._looksLikeQuestionSegment(last)
  }

  async _tryCohesionEmit (armedAt = Date.now()) {
    if (!this._messages.length) return false

    if (this._shouldHoldForVad()) {
      this._info('namo_cohesion_hold', {
        reason: 'vad_speech_active',
        bufferedChunks: this._messages.length
      })
      return false
    }

    const joinedText = this._joinedText()
    const lastText = this._lastSegmentText()
    if (!lastText) return false

    const version = this.candidateVersion
    const joinedResult = await this.detector.predict(joinedText)
    const segmentResult = lastText === joinedText
      ? joinedResult
      : await this.detector.predict(lastText)

    if (version !== this.candidateVersion) {
      this._info('namo_cohesion_stale', {
        evaluatedVersion: version,
        currentVersion: this.candidateVersion,
        bufferedChunks: this._messages.length
      })
      return false
    }

    const joinedComplete = joinedResult.eouProbability >= this.threshold
    const segmentComplete = segmentResult.eouProbability >= this.threshold
    const bufferedMs = this.pendingStartedAt == null ? 0 : Date.now() - this.pendingStartedAt
    const looksLikeCompleteQuestion = this._looksLikeQuestionCandidate(joinedText, lastText)
    const forceQuestionFlush = !joinedComplete &&
      looksLikeCompleteQuestion &&
      this.questionFlushMs > 0 &&
      bufferedMs >= this.questionFlushMs

    this._info('namo_cohesion_eval', {
      bufferedChunks: this._messages.length,
      bufferedMs,
      emitStableMs: this.emitStableMs,
      actualStableMs: Date.now() - armedAt,
      joinedComplete,
      segmentComplete,
      joinedEouProbability: Number(joinedResult.eouProbability.toFixed(6)),
      segmentEouProbability: Number(segmentResult.eouProbability.toFixed(6)),
      forceQuestionFlush,
      preview: joinedText.substring(0, 160)
    })

    if (segmentComplete && !joinedComplete && this._messages.length > 1) {
      this._info('namo_cohesion_hold', {
        reason: 'segment_complete_joined_incomplete',
        bufferedChunks: this._messages.length,
        preview: joinedText.substring(0, 160)
      })
      return false
    }

    if (joinedComplete || forceQuestionFlush) {
      const reason = forceQuestionFlush ? 'question_heuristic' : 'model_complete'
      this._requestSemanticFlush(reason, joinedResult)
      return true
    }

    if (segmentComplete && this._messages.length === 1) {
      this._requestSemanticFlush('model_complete', segmentResult)
      return true
    }

    return false
  }

  _armMaxWaitTimer () {
    this._clearMaxWaitTimer()
    const elapsed = this.pendingStartedAt == null ? 0 : Date.now() - this.pendingStartedAt
    const remainingMs = Math.max(0, this.maxWaitMs - elapsed)
    const armedAt = Date.now()
    this.maxWaitTimer = setTimeout(() => {
      this._info('namo_max_wait_fired', {
        maxWaitMs: this.maxWaitMs,
        remainingMs,
        actualWaitMs: Date.now() - armedAt,
        bufferedChunks: this._messages.length,
        action: 'flush'
      })
      this._flushPending('max_wait')
    }, remainingMs)

    this._info('namo_max_wait_armed', {
      maxWaitMs: this.maxWaitMs,
      remainingMs,
      bufferedChunks: this._messages.length,
      armedAt
    })
    if (this.eventEmitter) {
      this.eventEmitter.emit('voip.namoTimerArmed', {
        maxWaitMs: this.maxWaitMs,
        remainingMs,
        bufferedChunks: this._messages.length,
        armedAt
      })
      // Preserve compatibility with the existing VoipWaitTracker until it
      // learns the semantic gate event explicitly.
      this.eventEmitter.emit('voip.psstTimerArmed', {
        joinTimeoutMs: this.maxWaitMs,
        remainingMs,
        bufferedChunks: this._messages.length,
        armedAt,
        strategy: HANDLING_NAMO
      })
    }
  }

  _scheduleDecision () {
    this._clearDecisionTimer()
    const version = this.candidateVersion
    this.decisionTimer = setTimeout(() => {
      this.decisionTimer = null
      this.decisionChain = this.decisionChain
        .then(() => this._evaluateCandidate(version))
        .catch(err => this._handleInferenceError(err))
    }, this.minWaitMs)
  }

  async _evaluateCandidate (version) {
    if (!this._messages.length || version !== this.candidateVersion) return
    const text = this._joinedText()
    const result = await this.detector.predict(text)

    if (version !== this.candidateVersion) {
      this._info('namo_decision_stale', {
        evaluatedVersion: version,
        currentVersion: this.candidateVersion,
        inferenceMs: result.inferenceMs
      })
      return
    }

    const complete = result.eouProbability >= this.threshold
    const bufferedMs = this.pendingStartedAt == null ? 0 : Date.now() - this.pendingStartedAt
    const lastText = this._lastSegmentText()
    const looksLikeCompleteQuestion = this._looksLikeQuestionCandidate(text, lastText)
    const forceQuestionFlush = !complete &&
      looksLikeCompleteQuestion &&
      this.questionFlushMs > 0 &&
      bufferedMs >= this.questionFlushMs
    const decision = (complete || forceQuestionFlush) ? 'complete' : 'incomplete'
    const vadSpeechActive = this.vadProcessor ? this.vadProcessor.speechActive : false
    this._info('namo_decision', {
      candidateVersion: version,
      decision,
      eouProbability: Number(result.eouProbability.toFixed(6)),
      incompleteProbability: Number(result.incompleteProbability.toFixed(6)),
      threshold: this.threshold,
      inferenceMs: result.inferenceMs,
      bufferedChunks: this._messages.length,
      bufferedMs,
      action: (complete || forceQuestionFlush) ? (this._shouldHoldForVad() ? 'vad_hold' : 'flush') : 'hold',
      vadSpeechActive,
      preview: text.substring(0, 160),
      ...(forceQuestionFlush ? { questionFlushMs: this.questionFlushMs } : {})
    })
    if (this.eventEmitter) {
      this.eventEmitter.emit('voip.namoDecision', {
        decision,
        eouProbability: result.eouProbability,
        incompleteProbability: result.incompleteProbability,
        threshold: this.threshold,
        inferenceMs: result.inferenceMs,
        bufferedChunks: this._messages.length,
        vadSpeechActive
      })
    }
    if (complete) {
      if (this.vadEnabled && this._messages.length === 1 && !this._shouldHoldForVad()) {
        if (this.emitStableMs <= 0) {
          this._requestSemanticFlush('model_complete', result)
        } else {
          this._armEmitStableTimer()
        }
      } else {
        this._requestSemanticFlush('model_complete', result)
      }
    } else if (forceQuestionFlush) {
      this._requestSemanticFlush('question_heuristic', result)
    }
  }

_vadGateMetadata () {
    if (!this.vadEnabled) return {}
    return {
      vadEnabled: true,
      vadSpeechActive: this._getVadSpeechActive(),
      vadSegmentEndedAt: this._getLastVadSpeechEndAt()
    }
  }

  _joinedMessage (reason, result) {
    const first = this._messages[0]
    const sourceData = this._messages.flatMap(sourceDataParts)
    const message = {
      ...first,
      messageText: this._joinedText(),
      sourceData: sourceData.length === 1 ? sourceData[0] : sourceData,
      namoGate: {
        reason,
        committed: true,
        turnId: this.turnId,
        revision: this.revision,
        bufferedChunks: this._messages.length,
        bufferedMs: this.pendingStartedAt == null ? 0 : Date.now() - this.pendingStartedAt,
        threshold: this.threshold,
        ...this._vadGateMetadata(),
        ...(result
          ? {
              eouProbability: result.eouProbability,
              incompleteProbability: result.incompleteProbability,
              inferenceMs: result.inferenceMs
            }
          : {})
      }
    }
    return message
  }

  _flushPending (reason, result) {
    if (!this._messages.length) return
    this.pendingVadFlush = false
    this.pendingVadResult = null
    this.pendingVadReason = null
    this._clearDecisionTimer()
    this._clearMaxWaitTimer()
    this._clearQuestionFlushTimer()
    this._clearEmitStableTimer()
    this._clearReopenTimer()
    const message = this._joinedMessage(reason, result)
    const chunkCount = this._messages.length
    this._info('namo_flush', {
      sessionId: this.sessionId,
      reason,
      turnId: this.turnId,
      revision: this.revision,
      committed: true,
      bufferedChunks: chunkCount,
      bufferedMs: message.namoGate.bufferedMs,
      textLength: message.messageText.length,
      eouProbability: result && Number(result.eouProbability.toFixed(6)),
      vadSpeechActive: message.namoGate.vadSpeechActive,
      preview: message.messageText.substring(0, 160)
    })
    if (this.eventEmitter) {
      try {
        this.eventEmitter.emit('ivr.turn.committed', {
          sessionId: this.sessionId,
          turnHandler: 'NAMO',
          reason,
          bufferedChunks: chunkCount
        })
      } catch (_) {}
    }
    this.pendingStartedAt = null
    this.candidateVersion++
    this.lastCommittedAt = Date.now()
    this._setLastVadSpeechEndAt(null)
    this.turnState = null
    this.turnId += 1
    this.revision = 0
    this.pendingVadFlush = false
    this.pendingVadResult = null
    this.pendingVadReason = null
    this._commitFlush(message)
  }

  _handleInferenceError (err) {
    this._onInferenceError(err)
  }
}

module.exports = { NamoTurnGate, TURN_BUFFERING, TURN_SOFT_ENDED, HANDLING_NAMO }
