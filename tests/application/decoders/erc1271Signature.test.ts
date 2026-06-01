import { describe, it, expect } from "vitest";
import { encodeAbiParameters, getAddress, type Hex } from "viem";
import { decodeEip1271Signature } from "../../../src/application/decoders/erc1271Signature";

const HANDLER = "0xaabbccddaabbccddaabbccddaabbccddaabbccdd" as Hex;
const SALT = ("0x" + "ab".repeat(32)) as Hex;
const STATIC_INPUT = "0xdeadbeef" as Hex;
const PROOF: Hex[] = [("0x" + "11".repeat(32)) as Hex];
const OFFCHAIN_INPUT = "0x1234" as Hex;

// The PayloadStruct ABI as defined in the decoder — must match exactly.
const PAYLOAD_STRUCT_ABI = [
  {
    type: "tuple" as const,
    name: "payload",
    components: [
      { name: "proof",        type: "bytes32[]" as const },
      {
        type: "tuple" as const,
        name: "params",
        components: [
          { name: "handler",     type: "address" as const },
          { name: "salt",        type: "bytes32" as const },
          { name: "staticInput", type: "bytes"   as const },
        ],
      },
      { name: "offchainInput", type: "bytes" as const },
    ],
  },
] as const;

/** Build a Format B signature (ERC1271Forwarder / CoWShed path). */
function buildFormatB({
  handler = HANDLER,
  salt = SALT,
  staticInput = STATIC_INPUT,
  proof = [] as Hex[],
  offchainInput = "0x" as Hex,
} = {}): Hex {
  const payloadEncoded = encodeAbiParameters(PAYLOAD_STRUCT_ABI, [
    { proof, params: { handler, salt, staticInput }, offchainInput },
  ]);
  // Format B: 384 zero bytes (GPv2Order.Data placeholder) + PayloadStruct ABI encoding
  return ("0x" + "00".repeat(384) + payloadEncoded.slice(2)) as Hex;
}

/** Build a Format A signature (ISafeSignatureVerifier / Safe path). */
function buildFormatA({
  handler = HANDLER,
  salt = SALT,
  staticInput = STATIC_INPUT,
  proof = [] as Hex[],
  offchainInput = "0x" as Hex,
} = {}): Hex {
  const payloadEncoded = encodeAbiParameters(PAYLOAD_STRUCT_ABI, [
    { proof, params: { handler, salt, staticInput }, offchainInput },
  ]);
  const payloadBytes = payloadEncoded.slice(2); // strip "0x"
  const payloadLen = payloadBytes.length / 2;

  // Format A byte layout (all offsets in bytes):
  //   0–3     selector        4 bytes
  //   4–35    domainSeparator 32 bytes
  //   36–67   typeHash        32 bytes
  //   68–99   ABI offset to encodeData (=0x80=128 from byte 68)    32 bytes
  //   100–131 ABI offset to payload (=0x220=544 from byte 68)      32 bytes
  //   132–163 encodeData length (= 384)                            32 bytes
  //   164–547 abi.encode(GPv2Order.Data)  384 bytes
  //   548–579 payload length              32 bytes
  //   580–N   abi.encode(PayloadStruct)
  const padHex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, "0");
  const hex = [
    "5fd7e97d",                              // selector (no 0x prefix here)
    "00".repeat(32),                         // domainSeparator
    "00".repeat(32),                         // typeHash
    padHex(0x80, 32),                        // offset to encodeData
    padHex(0x220, 32),                       // offset to payload
    padHex(384, 32),                         // encodeData length = 384
    "00".repeat(384),                        // GPv2Order.Data placeholder
    padHex(payloadLen, 32),                  // payload length
    payloadBytes,                            // abi.encode(PayloadStruct)
  ].join("");
  return ("0x" + hex) as Hex;
}

// ─── Format B (ERC1271Forwarder / CoWShed) ────────────────────────────────────

describe("decodeEip1271Signature — Format B (ERC1271Forwarder)", () => {
  it("round-trips handler, salt, staticInput", () => {
    const sig = buildFormatB();
    const result = decodeEip1271Signature(sig);
    expect(result).not.toBeNull();
    expect(result!.handler).toBe(HANDLER.toLowerCase());
    expect(result!.salt).toBe(SALT);
    expect(result!.staticInput).toBe(STATIC_INPUT);
  });

  it("normalises handler address to lowercase", () => {
    // viem requires checksummed addresses for encoding; use getAddress() to checksum first,
    // then verify the decoder lowercases the output regardless of the encoded casing.
    const checksummed = getAddress(HANDLER);
    const sig = buildFormatB({ handler: checksummed });
    const result = decodeEip1271Signature(sig);
    expect(result!.handler).toBe(HANDLER.toLowerCase());
  });

  it("round-trips a non-empty proof array", () => {
    const sig = buildFormatB({ proof: PROOF });
    const result = decodeEip1271Signature(sig);
    expect(result!.proof).toEqual(PROOF);
  });

  it("round-trips offchainInput", () => {
    const sig = buildFormatB({ offchainInput: OFFCHAIN_INPUT });
    const result = decodeEip1271Signature(sig);
    expect(result!.offchainInput).toBe(OFFCHAIN_INPUT);
  });

  it("round-trips a multi-byte staticInput", () => {
    const longInput = ("0x" + "cc".repeat(64)) as Hex;
    const sig = buildFormatB({ staticInput: longInput });
    const result = decodeEip1271Signature(sig);
    expect(result!.staticInput).toBe(longInput);
  });
});

// ─── Format A (ISafeSignatureVerifier / Safe wallet) ─────────────────────────

describe("decodeEip1271Signature — Format A (ISafeSignatureVerifier)", () => {
  it("detects the 0x5fd7e97d selector and round-trips handler, salt, staticInput", () => {
    const sig = buildFormatA();
    const result = decodeEip1271Signature(sig);
    expect(result).not.toBeNull();
    expect(result!.handler).toBe(HANDLER.toLowerCase());
    expect(result!.salt).toBe(SALT);
    expect(result!.staticInput).toBe(STATIC_INPUT);
  });

  it("round-trips a non-empty proof via Format A", () => {
    const sig = buildFormatA({ proof: PROOF });
    const result = decodeEip1271Signature(sig);
    expect(result!.proof).toEqual(PROOF);
  });
});

// ─── Error / edge cases ───────────────────────────────────────────────────────

describe("decodeEip1271Signature — invalid inputs", () => {
  it("returns null for empty hex string", () => {
    expect(decodeEip1271Signature("0x")).toBeNull();
  });

  it("returns null for a signature that is too short to contain a payload", () => {
    // Only 10 bytes — nothing to decode
    expect(decodeEip1271Signature(("0x" + "aa".repeat(10)) as Hex)).toBeNull();
  });

  it("returns null for random garbage bytes", () => {
    const garbage = ("0x" + "ff".repeat(200)) as Hex;
    expect(decodeEip1271Signature(garbage)).toBeNull();
  });
});
