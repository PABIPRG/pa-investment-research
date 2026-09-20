/** Deterministic PNG and ICO primitives for the APP-ICON-001 asset pipeline. */

import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS = 4

export interface RgbaImage {
  data: Buffer
  height: number
  width: number
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

/** Encode an 8-bit RGBA image as a stable, non-interlaced sRGB PNG. */
export function encodePng(image: RgbaImage): Buffer {
  if (image.data.length !== image.width * image.height * CHANNELS) {
    throw new TypeError('RGBA byte length does not match the image dimensions')
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = image.width * CHANNELS
  const scanlines = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    image.data.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('sRGB', Buffer.from([0])),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  if (aboveDistance <= upperLeftDistance) return above
  return upperLeft
}

/** Decode the non-interlaced 8-bit RGBA PNGs used by the application icon pipeline. */
export function decodePng(png: Buffer): RgbaImage {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new TypeError('Expected a PNG signature')
  }
  let width = 0
  let height = 0
  const compressed: Buffer[] = []
  for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = png.readUInt32BE(offset + 8 + length)
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new TypeError(`PNG ${type} chunk has an invalid CRC`)
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new TypeError('Only non-interlaced 8-bit RGBA PNGs are supported')
      }
    } else if (type === 'IDAT') {
      compressed.push(data)
    }
    offset += 12 + length
  }
  if (width === 0 || height === 0 || compressed.length === 0) {
    throw new TypeError('PNG is missing IHDR or IDAT data')
  }
  const stride = width * CHANNELS
  const scanlines = inflateSync(Buffer.concat(compressed))
  if (scanlines.length !== (stride + 1) * height) {
    throw new TypeError('PNG scanline length does not match its dimensions')
  }
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const source = y * (stride + 1)
    const filter = scanlines.readUInt8(source)
    for (let x = 0; x < stride; x += 1) {
      const raw = scanlines.readUInt8(source + 1 + x)
      const target = y * stride + x
      const left = x >= CHANNELS ? pixels.readUInt8(target - CHANNELS) : 0
      const above = y > 0 ? pixels.readUInt8(target - stride) : 0
      const upperLeft = y > 0 && x >= CHANNELS ? pixels.readUInt8(target - stride - CHANNELS) : 0
      if (filter === 0) pixels[target] = raw
      else if (filter === 1) pixels[target] = raw + left
      else if (filter === 2) pixels[target] = raw + above
      else if (filter === 3) pixels[target] = raw + Math.floor((left + above) / 2)
      else if (filter === 4) pixels[target] = raw + paeth(left, above, upperLeft)
      else throw new TypeError(`Unsupported PNG filter ${filter}`)
    }
  }
  return { data: pixels, height, width }
}

/** Downsample an image with an area filter and premultiplied-alpha color averaging. */
export function resizeSquare(source: RgbaImage, size: number): RgbaImage {
  if (source.width !== source.height || !Number.isInteger(size) || size <= 0 || size > source.width) {
    throw new TypeError('Icon resizing requires a positive square downsample target')
  }
  const scale = source.width / size
  const target = Buffer.alloc(size * size * CHANNELS)
  for (let targetY = 0; targetY < size; targetY += 1) {
    const top = targetY * scale
    const bottom = (targetY + 1) * scale
    for (let targetX = 0; targetX < size; targetX += 1) {
      const left = targetX * scale
      const right = (targetX + 1) * scale
      let alphaSum = 0
      let areaSum = 0
      let redSum = 0
      let greenSum = 0
      let blueSum = 0
      for (let sourceY = Math.floor(top); sourceY < Math.ceil(bottom); sourceY += 1) {
        const yWeight = Math.min(bottom, sourceY + 1) - Math.max(top, sourceY)
        for (let sourceX = Math.floor(left); sourceX < Math.ceil(right); sourceX += 1) {
          const xWeight = Math.min(right, sourceX + 1) - Math.max(left, sourceX)
          const weight = xWeight * yWeight
          const sourceOffset = (sourceY * source.width + sourceX) * CHANNELS
          const alpha = source.data.readUInt8(sourceOffset + 3) / 255
          areaSum += weight
          alphaSum += weight * alpha
          redSum += weight * alpha * source.data.readUInt8(sourceOffset)
          greenSum += weight * alpha * source.data.readUInt8(sourceOffset + 1)
          blueSum += weight * alpha * source.data.readUInt8(sourceOffset + 2)
        }
      }
      const targetOffset = (targetY * size + targetX) * CHANNELS
      target[targetOffset] = alphaSum === 0 ? 0 : Math.round(redSum / alphaSum)
      target[targetOffset + 1] = alphaSum === 0 ? 0 : Math.round(greenSum / alphaSum)
      target[targetOffset + 2] = alphaSum === 0 ? 0 : Math.round(blueSum / alphaSum)
      target[targetOffset + 3] = Math.round(255 * alphaSum / areaSum)
    }
  }
  return { data: target, height: size, width: size }
}

function insideRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
  const nearestX = Math.max(radius, Math.min(size - radius, x))
  const nearestY = Math.max(radius, Math.min(size - radius, y))
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2
}

/** Apply the Windows/Web transparent rounded plate without changing the brand artwork. */
export function applyRoundedPlate(image: RgbaImage, radiusRatio = 3 / 16): RgbaImage {
  if (image.width !== image.height) throw new TypeError('Rounded icon plates require a square image')
  const target = Buffer.from(image.data)
  const samples = 8
  const radius = image.width * radiusRatio
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      let inside = 0
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          if (insideRoundedSquare(
            x + (sampleX + 0.5) / samples,
            y + (sampleY + 0.5) / samples,
            image.width,
            radius,
          )) inside += 1
        }
      }
      const alphaOffset = (y * image.width + x) * CHANNELS + 3
      target[alphaOffset] = Math.round(target.readUInt8(alphaOffset) * inside / samples ** 2)
    }
  }
  return { data: target, height: image.height, width: image.width }
}

/** Package PNG icon frames into a Windows-compatible ICO container. */
export function encodeIco(frames: readonly { png: Buffer; size: number }[]): Buffer {
  const headerSize = 6 + frames.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = headerSize
  frames.forEach((frame, index) => {
    if (!Number.isInteger(frame.size) || frame.size <= 0 || frame.size > 256) {
      throw new TypeError(`ICO frame size ${frame.size} is outside 1..256`)
    }
    const entry = 6 + index * 16
    header[entry] = frame.size === 256 ? 0 : frame.size
    header[entry + 1] = frame.size === 256 ? 0 : frame.size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frame.png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frame.png.length
  })
  return Buffer.concat([header, ...frames.map(frame => frame.png)])
}

/** Read embedded PNG frames from an ICO file and reject malformed offsets or dimensions. */
export function decodeIco(ico: Buffer): readonly { png: Buffer; size: number }[] {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new TypeError('Expected a Windows icon container')
  }
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16
    const size = ico.readUInt8(entry) || 256
    if ((ico.readUInt8(entry + 1) || 256) !== size) throw new TypeError('ICO frame is not square')
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    if (offset < 6 + count * 16 || offset + length > ico.length) {
      throw new TypeError('ICO frame points outside the container')
    }
    return { png: ico.subarray(offset, offset + length), size }
  })
}

export function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data.readUInt8((y * image.width + x) * CHANNELS + 3)
}

/** Assert that every opaque white brand pixel fits inside the W3C maskable safe circle. */
export function assertMaskableSafeZone(image: RgbaImage): void {
  if (image.width !== image.height) throw new TypeError('Maskable icons must be square')
  const center = image.width / 2
  const radius = image.width * 0.4
  let whitePixels = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * CHANNELS
      const red = image.data.readUInt8(offset)
      const green = image.data.readUInt8(offset + 1)
      const blue = image.data.readUInt8(offset + 2)
      const alpha = image.data.readUInt8(offset + 3)
      if (alpha >= 240 && red >= 240 && green >= 240 && blue >= 240) {
        whitePixels += 1
        const pixelCenterX = x + 0.5
        const pixelCenterY = y + 0.5
        if (Math.hypot(pixelCenterX - center, pixelCenterY - center) > radius) {
          throw new TypeError(`White brand pixel (${x}, ${y}) escapes the 40% maskable safe zone`)
        }
      }
    }
  }
  if (whitePixels === 0) throw new TypeError('Maskable icon does not contain the white brand mark')
}
