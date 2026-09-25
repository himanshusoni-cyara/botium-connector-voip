const CONNECTOR_DEADLINE_FLOOR_MS = 800

const isTruthyCap = (v) => v !== false && v !== 'false' && v !== 0 && v !== '0'

const parseCapInt = (caps, key, fallback) => {
  const parsed = parseInt(caps[key], 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Wall-clock ms when IVR speech ended for the current STT final (speechEndSec on recording timeline).
 */
function speechEndAtMsFromFinal ({ finalAtMs, recordingAtSttFinalSec, speechEndSec }) {
  if (!Number.isFinite(finalAtMs)) return null
  if (!Number.isFinite(recordingAtSttFinalSec) || !Number.isFinite(speechEndSec)) return null
  const lagSec = recordingAtSttFinalSec - speechEndSec
  if (!Number.isFinite(lagSec) || lagSec < 0) return null
  return Math.round(finalAtMs - lagSec * 1000)
}

function computeConnectorDeadlineMs (caps, Capabilities) {
  const budget = parseCapInt(caps, Capabilities.VOIP_REPLY_BUDGET_MS, 0)
  if (!budget || budget <= 0) return null
  const coach = parseCapInt(caps, Capabilities.VOIP_REPLY_COACH_RESERVE_MS, 2500)
  const wire = parseCapInt(caps, Capabilities.VOIP_REPLY_WIRE_RESERVE_MS, 800)
  const raw = budget - coach - wire
  return Math.max(CONNECTOR_DEADLINE_FLOOR_MS, raw)
}

function computeReplyConnectorDeadlineAtMs (speechEndAtMs, caps, Capabilities) {
  const connectorMs = computeConnectorDeadlineMs(caps, Capabilities)
  if (!connectorMs || !Number.isFinite(speechEndAtMs)) return null
  return speechEndAtMs + connectorMs
}

/**
 * When VOIP_OTS_LATENCY_PROFILE is enabled, apply latency-friendly defaults only for keys
 * the user did not set on the chatbot capability object.
 */
function applyOtsLatencyProfile (mergedCaps, userCaps, Capabilities, Defaults) {
  if (!isTruthyCap(mergedCaps[Capabilities.VOIP_OTS_LATENCY_PROFILE])) {
    return mergedCaps
  }
  const user = userCaps || {}
  const setIfUnset = (key, value) => {
    if (user[key] === undefined || user[key] === null || user[key] === '') {
      mergedCaps[key] = value
    }
  }
  setIfUnset(Capabilities.VOIP_REPLY_BUDGET_MS, 5000)
  setIfUnset(Capabilities.VOIP_REPLY_COACH_RESERVE_MS, 2500)
  setIfUnset(Capabilities.VOIP_REPLY_WIRE_RESERVE_MS, 800)
  setIfUnset(Capabilities.VOIP_NAMO_REOPEN_MS, 800)
  setIfUnset(Capabilities.VOIP_NAMO_EMIT_STABLE_MS, 500)
  setIfUnset(Capabilities.VOIP_NAMO_MAX_WAIT_MS, 3500)
  setIfUnset(Capabilities.VOIP_NAMO_MIN_WAIT_MS, 200)
  setIfUnset(Capabilities.VOIP_CED_ENABLE, false)
  setIfUnset(Capabilities.VOIP_STT_MESSAGE_HANDLING, 'NAMO')
  return mergedCaps
}

module.exports = {
  CONNECTOR_DEADLINE_FLOOR_MS,
  speechEndAtMsFromFinal,
  computeConnectorDeadlineMs,
  computeReplyConnectorDeadlineAtMs,
  applyOtsLatencyProfile,
  isTruthyCap,
  parseCapInt
}
