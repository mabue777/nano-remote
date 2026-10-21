import { describe, expect, it } from 'vitest';

import { encrypt, MAX_PLAINTEXT_BYTES, PushEncryptionError, RECORD_SIZE } from './encrypt.js';
import { decrypt, newReceiver } from './testing/web-push.js';

// RFC 8291 section 5 and Appendix A (base64url, whitespace removed).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const b = (s: string) => Buffer.from(s, 'base64url');

describe('RFC 8291 encryption', () => {
  it('replays Appendix A byte for byte: 86-octet header, ciphertext, and the section 5 message', () => {
    const body = encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(RFC.plaintext), {
      salt: b(RFC.salt),
      ephemeralPrivateKey: b(RFC.asPrivate),
    });
    expect(body.subarray(0, 86).toString('base64url')).toBe(RFC.header);
    expect(body.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
    expect(body.toString('base64url')).toBe(RFC.message);
    // 86 header + 41 plaintext + 1 delimiter + 16 tag. The section 5 example's "Content-Length: 145" is off by one.
    expect(body).toHaveLength(144);
  });

  it('the browser side (the receiver private key) decrypts the published message', () => {
    const { plaintext, recordSize } = decrypt(b(RFC.message), b(RFC.uaPrivate), RFC.auth);
    expect(plaintext.toString()).toBe(RFC.plaintext);
    expect(recordSize).toBe(4096);
  });

  it('round trips with a random salt and ephemeral key, which differ per message', () => {
    const receiver = newReceiver();
    const payload = Buffer.from(JSON.stringify({ title: 'mac', body: 'Approve?', url: '/session/s1' }));
    const one = encrypt(receiver.keys, payload);
    const two = encrypt(receiver.keys, payload);
    expect(one.equals(two)).toBe(false);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    for (const body of [one, two]) {
      const { plaintext, recordSize } = decrypt(body, receiver.privateKey, receiver.keys.auth);
      expect(plaintext.equals(payload)).toBe(true);
      expect(recordSize).toBe(RECORD_SIZE);
      expect(body.readUInt8(20)).toBe(65);
    }
    // The largest plaintext that fits one record still decrypts.
    const big = Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x61);
    expect(decrypt(encrypt(receiver.keys, big), receiver.privateKey, receiver.keys.auth).plaintext.equals(big)).toBe(true);
  });

  it('refuses bad receiver keys, a bad salt and an oversized plaintext', () => {
    const { keys } = newReceiver();
    const cases: [Parameters<typeof encrypt>, string][] = [
      [[{ ...keys, p256dh: 'AAAA' }, Buffer.from('x')], 'p256dh'],
      [[{ ...keys, p256dh: Buffer.alloc(65, 5).toString('base64url') }, Buffer.from('x')], 'p256dh'],
      [[{ ...keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') }, Buffer.from('x')], 'not a point'],
      [[{ ...keys, auth: 'AAAA' }, Buffer.from('x')], 'auth'],
      [[keys, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1)], 'plaintext'],
      [[keys, Buffer.from('x'), { salt: Buffer.alloc(8) }], 'salt'],
    ];
    for (const [args, message] of cases) {
      expect(() => encrypt(...args)).toThrow(PushEncryptionError);
      expect(() => encrypt(...args)).toThrow(message);
    }
  });
});
