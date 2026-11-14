import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238): códigos de 6 dígitos, janela de 30 s, HMAC-SHA1 — o padrão
// dos aplicativos autenticadores (Google Authenticator, Authy, 1Password…).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30;
const DIGITS = 6;

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, timeMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / STEP_S)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

/** Aceita o código atual e os vizinhos (±30 s), para tolerar relógio levemente fora. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== DIGITS) return false;
  let ok = false;
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(totpAt(secret, now + drift * STEP_S * 1000));
    if (timingSafeEqual(expected, given)) ok = true; // sem retorno antecipado: tempo constante
  }
  return ok;
}

export function otpauthUrl(secret: string, account: string, issuer = 'NewSales WhatsApp'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

/** Códigos de recuperação no formato xxxx-xxxx (uso único). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
