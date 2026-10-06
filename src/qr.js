import QRCode from 'qrcode';

// Keep every module on an integer pixel grid, including four clear modules around it.
export async function receiptQR(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('공유 주소를 확인해주세요.');
  const modules = QRCode.create(parsed.href, { errorCorrectionLevel: 'M' }).modules.size + 8;
  const dataUrl = await QRCode.toDataURL(parsed.href, {
    errorCorrectionLevel: 'M', margin: 4, scale: 8,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  return { dataUrl, size: modules * Math.max(1, Math.min(4, Math.floor(216 / modules))), modules };
}
