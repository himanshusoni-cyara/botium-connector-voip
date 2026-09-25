const { waitForOutboundAllowed } = require('./outbound-gate')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Optional legacy defer of coach-visible BotSays until inbound quiet + join window (PSST path).
 */
function createIvrDeliveryController ({
  getBotMsgs,
  getLastSttFinalAt,
  realFlush,
  inboundLane,
  sceneClassifier,
  caps,
  Capabilities,
  sessionId,
  _info
}) {
  let deliveryInFlight = false
  let cancelToken = 0

  const deliveryQuietMs = () => {
    const v = parseInt(caps[Capabilities.VOIP_IVR_DELIVERY_QUIET_MS], 10)
    return Number.isFinite(v) && v > 0 ? v : 400
  }

  const joinTimeoutMs = () => {
    const v = parseInt(caps[Capabilities.VOIP_IVR_JOIN_TIMEOUT_MS], 10)
    return Number.isFinite(v) && v > 0 ? v : 1000
  }

  const maxDeliveryWaitMs = () => {
    const v = parseInt(caps[Capabilities.VOIP_IVR_DELIVERY_MAX_WAIT_MS], 10)
    return Number.isFinite(v) && v > 0 ? v : 2500
  }

  const maxJoinChunks = () => {
    const v = parseInt(caps[Capabilities.VOIP_IVR_MAX_JOIN_CHUNKS], 10)
    return Number.isFinite(v) && v > 0 ? v : 4
  }

  const deferEnabled = () => {
    const v = caps[Capabilities.VOIP_IVR_DEFER_DELIVERY_ENABLE]
    if (v === false || v === 'false' || v === 0 || v === '0') return false
    return v === true || v === 'true' || v === 1 || v === '1'
  }

  function cancelPending () {
    cancelToken++
  }

  async function runDelivery (token) {
    const started = Date.now()
    const msgs = getBotMsgs()
    const chunks = (msgs && msgs.length) || 0
    if (!chunks) {
      _info('ivr_turn_delivery_skipped', { sessionId, reason: 'empty_buffer' })
      return
    }

    const joinMs = joinTimeoutMs()
    const quietMs = deliveryQuietMs()
    const capMs = maxDeliveryWaitMs()

    while (token === cancelToken) {
      const lastFinalAt = getLastSttFinalAt() || started
      const elapsed = Date.now() - started
      if (elapsed >= capMs) break
      const sinceFinal = Date.now() - lastFinalAt
      const silentMs = inboundLane ? inboundLane.msSinceSpeechSilent() : Infinity
      if (sinceFinal >= joinMs && silentMs >= quietMs) break
      await sleep(40)
    }

    if (token !== cancelToken) return
    const finalChunks = (getBotMsgs() && getBotMsgs().length) || 0
    if (!finalChunks) return

    await waitForOutboundAllowed({
      inboundLane,
      sceneClassifier,
      quietMs,
      maxWaitMs: Math.max(0, capMs - (Date.now() - started)),
      hasRecentSttPartial: () => false
    })

    if (token !== cancelToken) return
    const bufferedChunks = (getBotMsgs() && getBotMsgs().length) || 0
    _info('ivr_turn_delivered', {
      sessionId,
      bufferedChunks,
      deliveryWaitMs: Date.now() - started,
      sceneAtDelivery: sceneClassifier ? sceneClassifier.getScene() : 'unknown'
    })
    realFlush()
  }

  function requestDelivery () {
    if (!deferEnabled()) {
      realFlush()
      return
    }
    const chunks = (getBotMsgs() && getBotMsgs().length) || 0
    if (chunks > maxJoinChunks()) {
      realFlush()
      return
    }
    cancelPending()
    const token = cancelToken
    if (deliveryInFlight) {
      // chain: latest token wins when prior completes
    }
    deliveryInFlight = true
    runDelivery(token).finally(() => {
      deliveryInFlight = false
    })
  }

  return { requestDelivery, cancelPending, deferEnabled }
}

module.exports = { createIvrDeliveryController }
