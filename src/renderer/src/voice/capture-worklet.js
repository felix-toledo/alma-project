// AudioWorklet: the AudioContext runs at 16 kHz, so this only groups samples into 80 ms Int16 chunks (1280 samples),
// the frame size openWakeWord and the voice pipeline expect.
const CHUNK = 1280

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(CHUNK)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      this.buffer[this.filled++] = s < 0 ? s * 32768 : s * 32767
      if (this.filled === CHUNK) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer])
        this.buffer = new Int16Array(CHUNK)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('alma-capture', CaptureProcessor)
