// Librosa-style mel filterbank (sherpa-onnx / kaldi-native-fbank ten-vad settings).

const MEL_SCALE_SLOPE = 14.545078505785561 // 27 / log(6.4)

const melScaleSlaney = (freq) => {
  if (freq <= 1000) return (freq * 3) / 200.0
  return 15 + MEL_SCALE_SLOPE * Math.log(freq / 1000)
}

const inverseMelScaleSlaney = (mel) => {
  if (mel <= 15) return (200.0 / 3) * mel
  return 1000 * Math.exp((mel - 15) / MEL_SCALE_SLOPE)
}

/**
 * @returns {{ offset: number, weights: Float32Array }[]}
 */
const buildTenVadMelBanks = () => {
  const sampleFreq = 16000
  const windowLengthPadded = 1024
  const numFftBins = windowLengthPadded / 2
  const numBins = 40
  const lowFreq = 0
  const highFreq = 8000
  const melLow = melScaleSlaney(lowFreq)
  const melHigh = melScaleSlaney(highFreq)
  const melDelta = (melHigh - melLow) / (numBins + 1)

  const bins = []
  for (let bin = 0; bin < numBins; bin++) {
    const leftMel = melLow + bin * melDelta
    const centerMel = melLow + (bin + 1) * melDelta
    const rightMel = melLow + (bin + 2) * melDelta

    let leftHz = inverseMelScaleSlaney(leftMel)
    let centerHz = inverseMelScaleSlaney(centerMel)
    let rightHz = inverseMelScaleSlaney(rightMel)

    leftHz *= (windowLengthPadded + 1.0) / sampleFreq
    centerHz *= (windowLengthPadded + 1.0) / sampleFreq
    rightHz *= (windowLengthPadded + 1.0) / sampleFreq

    leftHz = Math.floor(leftHz)
    centerHz = Math.floor(centerHz)
    rightHz = Math.floor(rightHz)

    const thisBin = new Float32Array(numFftBins + 1)
    let firstIndex = -1
    let lastIndex = -1

    for (let i = 0; i < numFftBins + 1; i++) {
      const hz = i
      if (hz > leftHz && hz < rightHz) {
        let weight
        if (hz <= centerHz) {
          weight = (hz - leftHz) / (centerHz - leftHz)
        } else {
          weight = (rightHz - hz) / (rightHz - centerHz)
        }
        thisBin[i] = weight
        if (firstIndex === -1) firstIndex = i
        lastIndex = i
      }
    }

    if (firstIndex === -1) {
      throw new Error('ten-vad mel bin has no support')
    }
    const size = lastIndex + 1 - firstIndex
    bins.push({
      offset: firstIndex,
      weights: thisBin.subarray(firstIndex, firstIndex + size)
    })
  }
  return bins
}

const applyMelBanks = (melBanks, powerSpectrum, out) => {
  for (let i = 0; i < melBanks.length; i++) {
    const { offset, weights } = melBanks[i]
    let energy = 0
    for (let k = 0; k < weights.length; k++) {
      energy += weights[k] * powerSpectrum[k + offset]
    }
    out[i] = energy
  }
}

module.exports = {
  buildTenVadMelBanks,
  applyMelBanks
}
