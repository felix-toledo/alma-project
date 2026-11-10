// The phone's picture shrinking (spec 031 AC-8.1, BR-4): a convenience, the PC re-checks everything. One file at a time, nothing stored.
import { reencodedPictureName, shrinkToFit } from '../../shared/attach/phone'

export type Encoder = (source: Blob, step: { maxSide: number; quality: number }) => Promise<Blob>

/** The first re-encoding that fits, as `imagen-<timestamp>.jpg`; null when none fits or the picture cannot be decoded. The encoder is the browser's canvas (canvas.ts). */
export async function shrinkPicture(file: Blob, now: number, encode: Encoder): Promise<File | null> {
  const blob = await shrinkToFit((step) => encode(file, step))
  return blob ? new File([blob], reencodedPictureName(now), { type: 'image/jpeg' }) : null
}
