// The browser half of the picture shrinking (spec 031 AC-8.1): draws on a canvas. Glue with no rule; the steps and the fit test are shared.
import { shrinkPicture } from './shrink'

type Step = { maxSide: number; quality: number }

/** Older iOS Safari rejects the options bag, so a failure is tried once more with the browser's own defaults. */
async function decode(source: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source, { imageOrientation: 'from-image' })
  } catch {
    return createImageBitmap(source)
  }
}

/** Draws the decoded picture at the step's longest side and re-encodes it as JPEG; the canvas is released before returning (old phones run out of memory). */
async function draw(bitmap: ImageBitmap, step: Step): Promise<Blob> {
  const canvas = document.createElement('canvas')
  try {
    const scale = Math.min(1, step.maxSide / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no canvas')
    // JPEG has no alpha: a transparent PNG would turn black.
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', step.quality))
    if (!blob) throw new Error('encoding failed')
    return blob
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * The first JPEG of the shrink steps that fits, or null when none does. The picture is decoded once for every step; one that
 * cannot be decoded throws, so the chip says the phone could not read it rather than that the file is too big.
 */
export async function shrinkInBrowser(file: File, now: number): Promise<File | null> {
  const bitmap = await decode(file)
  try {
    return await shrinkPicture(file, now, (_source, step) => draw(bitmap, step))
  } finally {
    bitmap.close()
  }
}
