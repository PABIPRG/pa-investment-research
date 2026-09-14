import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

/** Public challenge; the answer is present only in raster pixels. */
export interface CaptchaView { id: string; image: string; expiresAt: number }
/** Untrusted proof supplied in the login JSON body. */
export interface CaptchaProof { id: string; answer: string }
/** Server-only answer digest, held inside one client record. */
export interface CaptchaRecord { id: string; answerHash: Buffer; expiresAt: number }

const WIDTH = 216
const HEIGHT = 64
// Original 5×7 numeral masks; no font files or platform font renderer required.
const DIGITS = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
]

function answerHash(id: string, answer: string): Buffer {
  return createHash('sha256').update(id).update(':').update(answer).digest()
}

function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes])
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

// A fixed-size grayscale PNG carries no text chunks, SVG markup or answer metadata.
function render(answer: string): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, 247)
  const paint = (x: number, y: number, shade: number) => {
    x = Math.round(x); y = Math.round(y)
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y * WIDTH + x] = shade
  }
  for (let n = 0; n < 260; n++) paint(randomInt(WIDTH), randomInt(HEIGHT), randomInt(160, 225))
  for (let index = 0; index < answer.length; index++) {
    const mask = DIGITS[Number(answer[index])]!
    const offsetY = randomInt(10, 19)
    const skew = randomInt(-18, 19) / 100
    const phase = randomInt(100) / 10
    for (let y = 0; y < 35; y++) for (let x = 0; x < 25; x++) {
      if (mask[Math.floor(y / 5)]![Math.floor(x / 5)] !== '1') continue
      paint(12 + index * 33 + x + skew * (y - 17) + Math.sin(y / 8 + phase) * 1.5,
        offsetY + y, randomInt(30, 75))
    }
  }
  for (let line = 0; line < 2; line++) {
    const phase = randomInt(100) / 10
    for (let x = 0; x < WIDTH; x++) paint(x, 24 + line * 17 + Math.sin(x / 23 + phase) * 8, 130)
  }
  const rows = Buffer.alloc((WIDTH + 1) * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) pixels.copy(rows, y * (WIDTH + 1) + 1, y * WIDTH, (y + 1) * WIDTH)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4); header[8] = 8
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Generate a six-digit challenge with a two-minute server deadline.
 * @returns private digest and public PNG view; neither contains the plaintext answer.
 */
export function createCaptcha(): { record: CaptchaRecord; view: CaptchaView } {
  const id = randomBytes(32).toString('base64url')
  const answer = Array.from({ length: 6 }, () => String(randomInt(2, 10))).join('')
  const expiresAt = Date.now() + 120_000
  return { record: { id, answerHash: answerHash(id, answer), expiresAt },
    view: { id, expiresAt, image: `data:image/png;base64,${render(answer).toString('base64')}` } }
}

/**
 * Compare a submitted proof against the client's consumed server record.
 * @param record - server-only record, removed from storage before this check.
 * @param proof - submitted id and six digits.
 * @returns whether id, answer and deadline all match.
 */
export function verifyCaptcha(record: CaptchaRecord, proof: CaptchaProof): boolean {
  return record.expiresAt > Date.now() && proof.id === record.id && /^\d{6}$/.test(proof.answer)
    && timingSafeEqual(record.answerHash, answerHash(proof.id, proof.answer))
}
