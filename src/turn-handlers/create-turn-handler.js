const { NamoTurnHandler } = require('./namo-turn-handler')

const createTurnHandler = (caps, Capabilities, ctx) => {
  const raw = caps && caps[Capabilities.VOIP_STT_TURN_HANDLER]
  const key = String(raw || 'NAMO').toUpperCase()
  if (key === 'SMART_TURN' || key === 'PSST') {
    ctx._info('voip_turn_handler_legacy_mapped', {
      sessionId: ctx.sessionId,
      from: key,
      to: 'NAMO'
    })
  }
  return new NamoTurnHandler(ctx)
}

module.exports = { createTurnHandler }
