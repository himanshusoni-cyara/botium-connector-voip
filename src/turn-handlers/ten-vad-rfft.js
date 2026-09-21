// Real FFT (n=1024) packed like kaldi-native-fbank / kiss_fftr (sherpa ten-vad).

const twiddleCos = new Float32Array(1024)
const twiddleSin = new Float32Array(1024)
for (let k = 0; k < 1024; k++) {
  const w = (-2 * Math.PI * k) / 1024
  twiddleCos[k] = Math.cos(w)
  twiddleSin[k] = Math.sin(w)
}

/**
 * @param {Float32Array} inOut length 1024 time-domain samples, overwritten with packed spectrum
 */
const rfftKaldi1024 = (inOut) => {
  const N = 1024
  const half = N / 2
  let re0 = 0
  let reNyq = 0
  const binsRe = new Float32Array(half)
  const binsIm = new Float32Array(half)

  for (let k = 0; k <= half; k++) {
    let re = 0
    let im = 0
    for (let n = 0; n < N; n++) {
      const sample = inOut[n]
      const angle = (k * n) % 1024
      re += sample * twiddleCos[angle]
      im += sample * twiddleSin[angle]
    }
    if (k === 0) {
      re0 = re
    } else if (k === half) {
      reNyq = re
    } else {
      binsRe[k] = re
      binsIm[k] = im
    }
  }

  inOut[0] = re0
  inOut[1] = reNyq
  for (let i = 1; i < half; i++) {
    inOut[2 * i] = binsRe[i]
    inOut[2 * i + 1] = binsIm[i]
  }
}

module.exports = {
  rfftKaldi1024
}
