import { isIP } from 'node:net';

/** Conservative global-unicast test used at every restricted-egress boundary. */
export function isGloballyRoutableIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isGloballyRoutableIpv4(address);
  if (family !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  // IPv4-mapped and compatible forms inherit the embedded IPv4 policy.
  if (bytes.subarray(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isGloballyRoutableIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.subarray(0, 12).every((value) => value === 0)) return false;

  // Accept only global unicast 2000::/3, then remove special-use ranges
  // within it. This intentionally fails closed for transition mechanisms.
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  if (prefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return false; // Teredo
  if (prefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48)) return false; // benchmarking
  if (prefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)) return false; // ORCHID
  if (prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (prefix(bytes, [0x20, 0x02], 16)) return false; // 6to4 embeds IPv4
  return true;
}

function isGloballyRoutableIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function parseIpv6(address: string): Buffer | undefined {
  let input = address.toLowerCase();
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);
  const mapped = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) {
    const octets = mapped[2]!.split('.').map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
    input = `${mapped[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  if ((input.match(/::/gu) ?? []).length > 1) return undefined;
  const [leftText, rightText] = input.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((input.includes('::') && missing < 1) || (!input.includes('::') && missing !== 0)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function prefix(value: Buffer, expected: number[], bits: number): boolean {
  const complete = Math.floor(bits / 8);
  for (let index = 0; index < complete; index += 1) if (value[index] !== expected[index]) return false;
  const remaining = bits % 8;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining);
  return (value[complete]! & mask) === (expected[complete]! & mask);
}
