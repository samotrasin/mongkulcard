// KHQR (Cambodia's EMVCo QR) for one payment: exact amount, order number, and an expiry time.
// Layout matches NBC's KHQR format and the bakong-khqr library:
//   00 format "01" · 01 "12" (one-time) · 29 individual Bakong account · 52 category · 53 currency · 54 amount
//   58 "KH" · 59 name · 60 city · 62 extra (03 store, 01 bill number, 07 terminal) · 99 (00 made-at, 01 expires-at, ms) · 63 CRC

const enc = new TextEncoder();

function tlv(tag, value) {
  const v = String(value);
  const len = enc.encode(v).length;
  if (len > 99) throw new Error(`KHQR field ${tag} too long`);
  return tag + String(len).padStart(2, '0') + v;
}

export function crc16(str) {
  let crc = 0xffff;
  for (const byte of enc.encode(str)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// amountCents: integer cents for USD (e.g. 4999 = $49.99); riel uses whole riel.
export function makeKhqr({ accountId, merchantName, city, currency = 'USD', amountCents, billNumber, storeLabel, terminal = 'web', createdMs, expiresMs }) {
  if (!/^[A-Za-z0-9._-]{1,32}@[A-Za-z0-9_-]{2,16}$/.test(accountId || '')) throw new Error('Bakong account ID is not set or not valid');
  const cur = currency === 'KHR' ? '116' : '840';
  const amount = currency === 'KHR' ? String(Math.round(amountCents)) : String(amountCents / 100);
  let s = '';
  s += tlv('00', '01');
  s += tlv('01', '12');
  s += tlv('29', tlv('00', accountId));
  s += tlv('52', '5999');
  s += tlv('53', cur);
  s += tlv('54', amount);
  s += tlv('58', 'KH');
  s += tlv('59', merchantName.slice(0, 25));
  s += tlv('60', city.slice(0, 15));
  s += tlv('62', tlv('03', (storeLabel || merchantName).slice(0, 25)) + tlv('01', billNumber.slice(0, 25)) + tlv('07', terminal.slice(0, 25)));
  s += tlv('99', tlv('00', String(createdMs)) + tlv('01', String(expiresMs)));
  s += '6304';
  return s + crc16(s);
}

export async function md5Hex(str) {
  // Workers support MD5 in crypto.subtle.digest (non-standard but available).
  const buf = await crypto.subtle.digest('MD5', enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
