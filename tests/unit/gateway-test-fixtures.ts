import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These self-signed certificate keys are intentionally public, test-only
// material. They must never be copied into production state or documentation.

export const TEST_GATEWAY_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDoDCCAoigAwIBAgIUVeUzvOILkLJbwMMZZcOP/K9OXBMwDQYJKoZIhvcNAQEL
BQAwNTEdMBsGA1UEAwwUZ2F0ZXdheS5leGFtcGxlLnRlc3QxFDASBgNVBAoMC1F1
YmljbCBUZXN0MCAXDTI2MDgyNzIxMjIzNFoYDzIxMjYwODAzMjEyMjM0WjA1MR0w
GwYDVQQDDBRnYXRld2F5LmV4YW1wbGUudGVzdDEUMBIGA1UECgwLUXViaWNsIFRl
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC8bULSFKSkZaFP/srB
lzyq2d531NOHf6TyVpMTyStkkXX0LD5CS3N41Gol4U1rbPyTpaGRyQKuHFszjEyV
TPlNIlrfaA34lp24jObnNadir6cuV89HeSIxqwjCm3HFYY8qe1O+68BYKC9tyLM9
Zpb7OvZFbn+Tq6uusxpQqoLQ3lyqovQrE6AwZFadzTMX+OJHgw5cYS7EDuVDtKYg
xaRp+Or+YPhsp5qjR3MOe8msWgMXmtdIXKXqXSLqU5M4dSc/W9Xq0Gd3aA6dXK5R
lPnWUpqyEn37d91e6o80g2GVNQbabxANgkS4MYSHT2A4o7Jva1sfvg5J8UTyuCO1
gYFhAgMBAAGjgaUwgaIwHQYDVR0OBBYEFJt9Ospp+B7gEfVrtIM8ISzPWvyMMB8G
A1UdIwQYMBaAFJt9Ospp+B7gEfVrtIM8ISzPWvyMMA8GA1UdEwEB/wQFMAMBAf8w
TwYDVR0RBEgwRoIUZ2F0ZXdheS5leGFtcGxlLnRlc3SCFioucHJldmlldy5leGFt
cGxlLnRlc3SHBMAAAgqHECABDbgAAAAAAAAAAAAAABAwDQYJKoZIhvcNAQELBQAD
ggEBAEtFjiiCavQ+D6lYaWPGcU/f3peOJ5r15peVtf0JsG1Yoy+smcg0GBOiXUmR
lXgyd+V/LeC4Zlek5vU1VX+8QPpMwar+HfyPiM8xfJEiu1bU3iil2313r0YTAR4L
C85xhU/kpHWqB/SSgHO91a+XmjVQG8ab3CsllR4mSOO13HU5kXkpBCvSibVqyqW9
WG3ezXk1vhubXrSrA1aRpFo3Ckui9ZiDN+MpR5w0OYkjiBYpVdXMxAaBNnikaESh
Ys5HfTfEQ3GVKeV5CwDKlInJkSYB+1YORvNM4cTYW/4vGvH3vglyEJnqg69+zlkg
szLb30vKtjqKCtowP2h5Mb3AryQ=
-----END CERTIFICATE-----
`;

export const TEST_GATEWAY_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC8bULSFKSkZaFP
/srBlzyq2d531NOHf6TyVpMTyStkkXX0LD5CS3N41Gol4U1rbPyTpaGRyQKuHFsz
jEyVTPlNIlrfaA34lp24jObnNadir6cuV89HeSIxqwjCm3HFYY8qe1O+68BYKC9t
yLM9Zpb7OvZFbn+Tq6uusxpQqoLQ3lyqovQrE6AwZFadzTMX+OJHgw5cYS7EDuVD
tKYgxaRp+Or+YPhsp5qjR3MOe8msWgMXmtdIXKXqXSLqU5M4dSc/W9Xq0Gd3aA6d
XK5RlPnWUpqyEn37d91e6o80g2GVNQbabxANgkS4MYSHT2A4o7Jva1sfvg5J8UTy
uCO1gYFhAgMBAAECggEAAJklQvS8Z819TKJ0YjNvAwcg92xKQ7C9biSzsbMKPGi2
GFa1dEhKEeHmpqab7UYQ9dT8xjwB4JLijoTFRsB1to3TmtZyHCG6LG+dh45c+5Xv
UadHIeaq0RU/G/iBnro1W442Q7qsofohPWtA1FEPvvUV84xz8RlYMZ/k6tA6qXSR
M/ezrhuz+OV+gln61tBEn2ys5aD6TICJDgkbqKUq9wMYgJEmtSge55sGOuI0QJrl
s4csQqQJSQHMrX6RJOgREanRnkCYgplcYTlvMItgiNMK6Sy0WFlaClz+YsdVGgVQ
Zc5Fh4IhRzD/3w8HOsI61Q5rKxv8O4c/uSRjAxdU+QKBgQD3ScQoN9VWF16/Lhel
YtNNuPUUCojqjgFxDEXv1q65+dgASoc/GaOT4S4BmW2D765EeC6nPYP6cfIIbZTi
sYly/p+Zd3MDc8Qp0PuaCbwR5E25u+92s3ibPo0g3Ob2TN9QVPIzcJjjcSLVnRZE
bHQMUFccIFL+U5POI18ft3Rm+QKBgQDDEKNaSkxbTYqWGvtUcUtAwhFiaAI4yWvL
/1GyPEpaVUJxjSCpT0MtdU5uaL9uNvnNlNzwwR8P7jk3sD0O2lwfw07zpv+ye7mE
9vynjock1uhXpVrvJ7J/MR7n7qjRlTvA70LcpPyCHnBMymQ6A/ptMKCxHP85gSC/
WOA3cDR/qQKBgDPAETflb1Tj8SULLVGkG9pREaDPD5Yef7i7u8sUX152Jbjx39nZ
sLzay/jztdJ9jzeu+vxuyDbaL6+J1zWVt9ED7jx8neokCPJDVNQIo34PDCEJbnSl
3GCIt5ogAImczsMN893F+4jlfUe85xMMq0CEc6ZkMVod/XmPN3H4v3hpAoGBAJVX
ZKkY3xK78BFyAN+qiYG/0s1zcdgGJbid9e8uh4JXajJDaTEW1Qi1meGf4ofAIUpK
4UiVonFw4m+HR4fal9NdlVGnlnYQkX2CFvc1gLQssN+BYnhc/SSx98Z8CtXCmmfh
BmClFAmOwk2YWlmseAsmwrA20hQ1j1vP8IGhLyBZAoGAO2B2NM4avuur9uWIh+XV
C9kYrG/9TAYIQwx65ZM2XPhMpEcUlhi6/+0a4f5DFnSYh0tMv/dkv8+X/1e8qV9O
GSU6HQ7h71AZBR2HhK7cveGRCxsEVXHkOr8wXw0Z0E/C1fumqhkJz70JYyhIs05p
AEQA1jPiSM0/i8gA1X4ZT0A=
-----END PRIVATE KEY-----
`;

export const TEST_MISMATCHED_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDEpbHgU5ecmdRn
GVt1pcuYSsbaBOOLlqtyZnnQCHrvI5ZWg+lq8BXb9+4euyeinA7Ucvgs/9VTH+0k
qqGhfRrWcAMHjhqWUf4+0z2fr8805Hfu9uOgARnOLLWbdcoE0wbIwAHwQ9FnWbD+
0b/03cZ/paWiRmzr/EZi0xoRZnkkFrA+XPgu/Hr3xY729tq4hkbTccxmzJUmmuJ9
FaoaQHz5ZNbR8W1NPLoYg3ABYg8BoDD2m6lxxfr6CH487u34NZzvNx4vig1q6ER3
O//cd4o9CDYkLHP6jkT8COro6+G+UI7y5Rub4lx0xJ4pBvdbE412Bxr+kirCqAN0
fBmNhM0vAgMBAAECggEAAbxesha6z2CSPei85HB2uBzs3W7OnWRSlhtudtYkU6kS
Qig+7rk40CzDltTbGDXdcaWkKC2H8ghlnP2+mIDUtFDfzfjEplAJ+P7/W8H/B73+
iwb14mswEaBWaA1ln55HQI1lVvwaRJnHlLBATAaLIoRRTnnlqz2aV3P6lm27owRm
SmKSu3N9kXPMJwdMgNO39vHONfNZ6E9e2Bij+TITSpMv0c/SrvngFeLrq59Qa6/d
STA3ciiYmMF+20ISrR2npncQUfMt5i0qD0zTzZUJuAAGFMnzaupTusxuH0S6+Z4e
hAlC91uXTzdelGgbbtodYRDvp85DdPW4PwCDW1diqQKBgQDnEqPZ7k+EnaqSW8jW
MjxoSnmZ+prpUtuWn7kOSS0nTPJ6vAKnmoP9tPgTVZTlA4rvdnaGew+dPg92CVs9
3CfSkq2w4fi7O/ocMj7yOkyoV7L4MMCVQOP0Yt19ZtC78C0PPU2CTsoFi92XXKE8
+g47jQOzrUJLZVEQ242epHQGRwKBgQDZ3Fmz0J5ZuU63NPpzGY0A+szCyxaE0E4p
zhn6XjgR5qX13QFcPsEd2XlqJiqEfPYR5+pxWH3U1rRkIlmGbcY0g5sAb6RqlgKh
UMPsCqxooKJtKZ3IqIUUI2M4iepcvtRzB1Yar8ClUl1977dx0rpuX3haYJ1rUxVc
7R4dKOct2QKBgC8AwKms6ynrtG2vE+xWLal9NL0Yl/hMLXS3Krp4MiIjadODePrE
2IJ8FFZCe1YWYWWScEusrqFqpVR6VMABj2wq///SB3l2msqvgdRd/YfkxvfrWtFB
cN0eWzWN+3mvQksuShzuj/OO3tVSN04jA1AjwBQFc03I3zORpX4Wr68zAoGAcLi/
PPeDBx+HJ+nkb+tXdptNmLgltaBl4OF/tXhMgI6bbgPksUrS9tPQK2kF9LkHRKp/
Nhg4OwjAG1NeiNyBgihZ6bbaFj/5qme0h4vaOuRqRhsTRYBUIuBQdS9+sHAYUlAI
cBRhk+hy8Tc37k+/IF6LUg/NQ3uggQ062JGSU7kCgYEAtcU2KDkViil68oJmgAWO
Fpak98fKQ2gXybBmHn8/4exc/R4EcXRx1xlpt1PZxDPv6WhW3iRCoT+NZemexsbk
KIMinQu9ZSWiJ6LOi3MK4f7BpYoDKiHf+Eq129NWRPzHX5xm5xloD0aEsol3VFqB
DnZXGZxWNYuwM3/FlA7QwPM=
-----END PRIVATE KEY-----
`;

export interface GatewayTlsFixture {
  root: string;
  certificate: string;
  privateKey: string;
  mismatchedPrivateKey: string;
  validFrom: Date;
  validTo: Date;
  validAt: Date;
}

export async function writeGatewayTlsFixture(prefix = 'qubicl-gateway-tls-'): Promise<GatewayTlsFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const certificate = join(root, 'certificate.pem');
  const privateKey = join(root, 'private-key.pem');
  const mismatchedPrivateKey = join(root, 'mismatched-private-key.pem');
  await Promise.all([
    writeFile(certificate, TEST_GATEWAY_CERTIFICATE_PEM, { mode: 0o600 }),
    writeFile(privateKey, TEST_GATEWAY_PRIVATE_KEY_PEM, { mode: 0o600 }),
    writeFile(mismatchedPrivateKey, TEST_MISMATCHED_PRIVATE_KEY_PEM, { mode: 0o600 }),
  ]);
  const parsed = new X509Certificate(TEST_GATEWAY_CERTIFICATE_PEM);
  const validFrom = new Date(parsed.validFrom);
  const validTo = new Date(parsed.validTo);
  const validAt = new Date(validFrom.getTime() + Math.floor((validTo.getTime() - validFrom.getTime()) / 2));
  return { root, certificate, privateKey, mismatchedPrivateKey, validFrom, validTo, validAt };
}
