// Minimal ambient types for the `noise-protocol` package (and its internal
// submodules we reach into for transport-phase encryption). The upstream
// package ships no types; these cover only what SAMVAD actually uses.
declare module 'noise-protocol' {
  export interface NoiseKeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface Split {
    tx: Buffer
    rx: Buffer
  }

  export type HandshakeState = unknown

  const noise: {
    PKLEN: number
    SKLEN: number
    keygen(): NoiseKeyPair
    initialize(
      pattern: string,
      initiator: boolean,
      prologue: Buffer,
      staticKeys?: NoiseKeyPair | null,
      ephemeralKeys?: NoiseKeyPair | null,
      remoteStaticKey?: Buffer | null,
      remoteEphemeralKey?: Buffer | null,
    ): HandshakeState
    writeMessage: {
      (state: HandshakeState, payload: Buffer, messageBuffer: Buffer): Split | undefined
      bytes: number
    }
    readMessage: {
      (state: HandshakeState, message: Buffer, payloadBuffer: Buffer): Split | undefined
      bytes: number
    }
    destroy(state: HandshakeState): void
  }

  export default noise
}

declare module 'noise-protocol/cipher' {
  interface Cipher {
    KEYLEN: number
    NONCELEN: number
    MACLEN: number
  }
  const createCipher: () => Cipher
  export default createCipher
}

declare module 'noise-protocol/cipher-state' {
  interface CipherState {
    STATELEN: number
    NONCELEN: number
    MACLEN: number
    encryptWithAd(state: Buffer, out: Buffer, ad: Buffer, plaintext: Buffer): void
    decryptWithAd(state: Buffer, out: Buffer, ad: Buffer, ciphertext: Buffer): void
  }
  const createCipherState: (opts: { cipher: unknown }) => CipherState
  export default createCipherState
}
