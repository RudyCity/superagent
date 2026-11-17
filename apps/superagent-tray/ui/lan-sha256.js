"use strict";
/** Incremental SHA-256 for user-selected Blob slices. No file data is retained. */
(() => {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const initial = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (n, bits) => (n >>> bits) | (n << (32 - bits));
  class LanStreamingSha256 {
    constructor() {
      this.state = new Uint32Array(initial);
      this.block = new Uint8Array(64);
      this.words = new Uint32Array(64);
      this.used = 0;
      this.total = 0;
      this.done = false;
    }
    _compress() {
      const w = this.words, b = this.block, h = this.state;
      for (let i = 0; i < 16; i++) {
        const p = i * 4;
        w[i] = ((b[p] << 24) | (b[p + 1] << 16) |
          (b[p + 2] << 8) | b[p + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], c = w[i - 2];
        w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          w[i - 7] + (rotr(c, 17) ^ rotr(c, 19) ^ (c >>> 10))) >>> 0;
      }
      let [a,b0,c,d,e,f,g,h0] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (h0 + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b0) ^ (a & c) ^ (b0 & c))) >>> 0;
        h0 = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b0; b0 = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b0) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + h0) >>> 0;
    }
    update(bytes) {
      if (this.done || !(bytes instanceof Uint8Array)) throw Error("Invalid SHA-256 input.");
      this.total += bytes.length;
      if (!Number.isSafeInteger(this.total) || this.total > 256 * 1024 * 1024)
        throw Error("Streaming SHA-256 file size exceeds V2 bound.");
      let index = 0;
      while (index < bytes.length) {
        const size = Math.min(64 - this.used, bytes.length - index);
        this.block.set(bytes.subarray(index, index + size), this.used);
        this.used += size; index += size;
        if (this.used === 64) {
          this._compress();
          this.used = 0;
        }
      }
      return this;
    }
    hex() {
      if (this.done) throw Error("SHA-256 already finalized.");
      const length = this.total * 8;
      // Padding is processed without counting it against the file-size limit.
      this.block[this.used++] = 0x80;
      if (this.used > 56) {
        this.block.fill(0, this.used);
        this._compress();
        this.used = 0;
      }
      this.block.fill(0, this.used, 56);
      const view = new DataView(this.block.buffer);
      view.setUint32(56, Math.floor(length / 0x100000000));
      view.setUint32(60, length >>> 0);
      this._compress();
      this.done = true;
      return Array.from(this.state, (value) => value.toString(16).padStart(8, "0")).join("");
    }
  }
  window.LanStreamingSha256 = LanStreamingSha256;
})();
