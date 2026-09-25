/**
 * Log-mel features for sherpa/CED-Tiny ONNX (matches torchaudio MelSpectrogram + AmplitudeToDB).
 * feats shape: [1, 64, num_frames] (sherpa/CED ONNX layout; model transposes internally)
 */

const SAMPLE_RATE = 16000
const N_FFT = 512
const WIN_LENGTH = 512
const HOP_LENGTH = 160
const N_MELS = 64
const F_MIN = 0
const F_MAX = 8000
const TOP_DB = 120

let melFilters = null

const hannWindow = () => {
  const w = new Float32Array(WIN_LENGTH)
  for (let i = 0; i < WIN_LENGTH; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN_LENGTH - 1)))
  }
  return w
}

const buildMelFilters = () => {
  if (melFilters) return melFilters
  const numFreqs = N_FFT / 2 + 1
  const fftFreqs = new Float32Array(numFreqs)
  for (let i = 0; i < numFreqs; i++) fftFreqs[i] = (i * SAMPLE_RATE) / N_FFT

  const melMin = 2595 * Math.log10(1 + F_MIN / 700)
  const melMax = 2595 * Math.log10(1 + F_MAX / 700)
  const melPoints = new Float32Array(N_MELS + 2)
  for (let i = 0; i < N_MELS + 2; i++) {
    melPoints[i] = melMin + (i * (melMax - melMin)) / (N_MELS + 1)
  }
  const hzPoints = new Float32Array(N_MELS + 2)
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPoints[i] = 700 * (Math.pow(10, melPoints[i] / 2595) - 1)
  }

  const filters = []
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float32Array(numFreqs)
    const left = hzPoints[m]
    const center = hzPoints[m + 1]
    const right = hzPoints[m + 2]
    for (let k = 0; k < numFreqs; k++) {
      const freq = fftFreqs[k]
      if (freq < left || freq > right) continue
      if (freq <= center) {
        f[k] = (freq - left) / (center - left)
      } else {
        f[k] = (right - freq) / (right - center)
      }
    }
    filters.push(f)
  }
  melFilters = filters
  return melFilters
}

const rfft512Power = (frame, window, outPower) => {
  const numFreqs = N_FFT / 2 + 1
  for (let k = 0; k < numFreqs; k++) {
    let re = 0
    let im = 0
    for (let n = 0; n < WIN_LENGTH; n++) {
      const x = frame[n] * window[n]
      const ang = (2 * Math.PI * k * n) / N_FFT
      re += x * Math.cos(ang)
      im -= x * Math.sin(ang)
    }
    outPower[k] = re * re + im * im
  }
}

const ampToDb = (melFrame) => {
  let maxDb = -Infinity
  for (let i = 0; i < melFrame.length; i++) {
    const x = Math.max(melFrame[i], 1e-10)
    const db = 10 * Math.log10(x)
    melFrame[i] = db
    if (db > maxDb) maxDb = db
  }
  const floor = maxDb - TOP_DB
  for (let i = 0; i < melFrame.length; i++) {
    if (melFrame[i] < floor) melFrame[i] = floor
  }
}

/**
 * @param {Float32Array} waveform mono 16 kHz (typically 1s window, zero-padded at start)
 * @returns {{ data: Float32Array, dims: [number, number, number] } | null}
 */
const computeCedFeats = (waveform) => {
  if (!waveform || waveform.length < HOP_LENGTH) return null
  const filters = buildMelFilters()
  const window = hannWindow()
  const numFrames = 1 + Math.floor((waveform.length - WIN_LENGTH) / HOP_LENGTH)
  if (numFrames <= 0) return null

  const power = new Float32Array(N_FFT / 2 + 1)
  const melFrame = new Float32Array(N_MELS)
  const data = new Float32Array(N_MELS * numFrames)
  const frame = new Float32Array(WIN_LENGTH)

  for (let t = 0; t < numFrames; t++) {
    const start = t * HOP_LENGTH
    frame.fill(0)
    const copyLen = Math.min(WIN_LENGTH, waveform.length - start)
    for (let i = 0; i < copyLen; i++) frame[i] = waveform[start + i]

    rfft512Power(frame, window, power)
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0
      const f = filters[m]
      for (let k = 0; k < power.length; k++) sum += power[k] * f[k]
      melFrame[m] = sum
    }
    ampToDb(melFrame)
    for (let m = 0; m < N_MELS; m++) {
      data[m * numFrames + t] = melFrame[m]
    }
  }

  return { data, dims: [1, N_MELS, numFrames] }
}

module.exports = {
  SAMPLE_RATE,
  computeCedFeats
}
