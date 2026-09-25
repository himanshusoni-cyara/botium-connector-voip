const HANDLING_NAMO = 'NAMO'

const normalizeHandling = (h) => String(h || '').trim().toUpperCase()

const isNamoHandling = (handling) => normalizeHandling(handling) === HANDLING_NAMO

const isBufferedSttHandling = (handling) => {
  const h = normalizeHandling(handling)
  return h === 'JOIN' || h === 'PSST' || h === 'CONCAT' || h === HANDLING_NAMO
}

module.exports = {
  HANDLING_NAMO,
  isNamoHandling,
  isBufferedSttHandling,
  normalizeHandling
}
