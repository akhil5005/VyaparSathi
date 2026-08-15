/**
 * Getting a phone photograph small enough to send.
 *
 * A modern phone camera produces 3–6 MB per frame, and several of those would
 * be a slow upload on a shop's connection and a needlessly large bill from the
 * model — images are charged by area, and a supplier invoice is perfectly
 * legible long before full sensor resolution.
 *
 * 1600px on the long edge is the compromise: printed invoice text stays sharp
 * enough to read, and the file lands around 200–400 KB. Downscaling here rather
 * than on the server also means the big file never leaves the phone.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

export interface PreparedImage {
  /// Base64 without the `data:` prefix, which is what the API expects.
  data: string;
  mediaType: 'image/jpeg';
  /// For showing the operator what was sent.
  previewUrl: string;
  bytes: number;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process the image');
  // Photographs of paper are all smooth gradients and text edges; the better
  // resampler is worth it for legibility at this scale.
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', QUALITY),
  );
  if (!blob) throw new Error('Could not read that image');

  const buffer = await blob.arrayBuffer();

  return {
    data: base64Of(buffer),
    mediaType: 'image/jpeg',
    previewUrl: URL.createObjectURL(blob),
    bytes: blob.size,
  };
}

/**
 * Base64 in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 400 KB image spreads four hundred
 * thousand arguments across a call and overflows the stack. Chunking is not an
 * optimisation here; the obvious version simply throws.
 */
function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
