const HEX_BYTE = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, "0"),
);

function toHex32(value: number): string {
  return (
    HEX_BYTE[(value >>> 24) & 0xff]! +
    HEX_BYTE[(value >>> 16) & 0xff]! +
    HEX_BYTE[(value >>> 8) & 0xff]! +
    HEX_BYTE[value & 0xff]!
  );
}

class StableStringHasher {
  private h1 = 1779033703;
  private h2 = 3144134277;
  private h3 = 1013904242;
  private h4 = 2773480762;

  update(input: string): void {
    const length = input.length;
    let index = 0;
    let h1 = this.h1;
    let h2 = this.h2;
    let h3 = this.h3;
    let h4 = this.h4;
    const unrolledLimit = length - 7;

    for (; index < unrolledLimit; index += 8) {
      let code = input.charCodeAt(index);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 1);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 2);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 3);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 4);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 5);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 6);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
      code = input.charCodeAt(index + 7);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
    }

    for (; index < length; index += 1) {
      const code = input.charCodeAt(index);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
    }

    this.h1 = h1;
    this.h2 = h2;
    this.h3 = h3;
    this.h4 = h4;
  }

  digestHex(): string {
    let h1 = Math.imul(this.h3 ^ (this.h1 >>> 18), 597399067);
    let h2 = Math.imul(this.h4 ^ (this.h2 >>> 22), 2869860233);
    let h3 = Math.imul(this.h1 ^ (this.h3 >>> 17), 951274213);
    let h4 = Math.imul(this.h2 ^ (this.h4 >>> 19), 2716044179);

    h1 = (h1 ^ h2 ^ h3 ^ h4) >>> 0;
    h2 = (h2 ^ h1) >>> 0;
    h3 = (h3 ^ h1) >>> 0;
    h4 = (h4 ^ h1) >>> 0;

    return `${toHex32(h1)}${toHex32(h2)}${toHex32(h3)}${toHex32(h4)}`;
  }
}

export function hashStableParts(parts: Iterable<string>): string {
  const hasher = new StableStringHasher();

  for (const part of parts) {
    hasher.update(String(part.length));
    hasher.update(":");
    hasher.update(part);
    hasher.update("|");
  }

  return hasher.digestHex();
}
