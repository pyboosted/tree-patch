function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

class StableStringHasher {
  private h1 = 1779033703;
  private h2 = 3144134277;
  private h3 = 1013904242;
  private h4 = 2773480762;

  update(input: string): void {
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      this.h1 = this.h2 ^ Math.imul(this.h1 ^ code, 597399067);
      this.h2 = this.h3 ^ Math.imul(this.h2 ^ code, 2869860233);
      this.h3 = this.h4 ^ Math.imul(this.h3 ^ code, 951274213);
      this.h4 = this.h1 ^ Math.imul(this.h4 ^ code, 2716044179);
    }
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

export function hashStableParts(parts: readonly string[]): string {
  const hasher = new StableStringHasher();

  for (const part of parts) {
    hasher.update(String(part.length));
    hasher.update(":");
    hasher.update(part);
    hasher.update("|");
  }

  return hasher.digestHex();
}
