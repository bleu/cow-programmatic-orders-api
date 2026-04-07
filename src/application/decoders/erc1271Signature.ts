/**
 * EIP-1271 signature decoder for ComposableCoW orders.
 *
 * Two signature formats appear in the wild, depending on the order owner:
 *
 * Format A — ISafeSignatureVerifier (Safe wallets with ExtensibleFallbackHandler):
 *   GPv2Settlement calls isValidSignature on the Safe; Safe's EFH forwards to
 *   ISafeSignatureVerifier with a structured payload prefixed by 0x5fd7e97d.
 *   Layout:
 *     selector(4) + domainSeparator(32) + typeHash(32) +
 *     ABI offsets(64) + encodeData(384) + payloadLen(32) + PayloadStruct(N)
 *
 * Format B — ERC1271Forwarder (CoWShedForComposableCoW and other non-Safe ERC1271):
 *   GPv2Settlement calls isValidSignature directly on the CoWShed proxy, which
 *   implements isValidSignature via ERC1271Forwarder:
 *     abi.decode(signature, (GPv2Order.Data, PayloadStruct))
 *   Layout: GPv2Order.Data(384 bytes fixed) + PayloadStruct(N bytes)
 *
 * Detection: presence of the 0x5fd7e97d function selector at bytes 0–3.
 *
 * Reference: composable-cow/src/ERC1271Forwarder.sol
 */

import { decodeAbiParameters, type Hex } from "viem";

// ─── ABI definitions ─────────────────────────────────────────────────────────

// GPv2Order.Data: 12 fixed-size fields × 32 bytes = 384 bytes total (used for byte-offset math)
const GPV2_ORDER_BYTES = 384;

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

// ─── Public interface ─────────────────────────────────────────────────────────

export interface DecodedEip1271Signature {
  handler: Hex;
  salt: Hex;
  staticInput: Hex;
  proof: Hex[];
  offchainInput: Hex;
}

/**
 * Decode an EIP-1271 signature from the CoW Orderbook API into its composable
 * order components. Returns null if the signature cannot be decoded (wrong format,
 * truncated bytes, or ABI decode failure).
 *
 * Does NOT filter on known handler addresses — callers should check against
 * COMPOSABLE_COW_HANDLER_ADDRESSES from src/data.ts if needed.
 */
export function decodeEip1271Signature(
  signature: Hex
): DecodedEip1271Signature | null {
  try {
    const selector = signature.slice(0, 10).toLowerCase();

    if (selector === "0x5fd7e97d") {
      return decodeIsafeSignatureVerifierFormat(signature);
    } else {
      return decodeErc1271ForwarderFormat(signature);
    }
  } catch {
    return null;
  }
}

// ─── Format implementations ───────────────────────────────────────────────────

/**
 * Format A: ISafeSignatureVerifier (0x5fd7e97d selector)
 *
 * Byte layout (offsets from start of hex string, after "0x"):
 *   0–3    selector (4 bytes)
 *   4–35   domainSeparator (32 bytes)
 *   36–67  typeHash (32 bytes)
 *   68–99  ABI offset to encodeData  [= 0x80 = 128 from byte 68]
 *   100–131 ABI offset to payload    [= 0x220 = 544 from byte 68]
 *   132–163 encodeData length (= 384)
 *   164–547 abi.encode(GPv2Order.Data)  — 384 bytes
 *   548–579 payload length
 *   580–N   abi.encode(PayloadStruct)
 */
function decodeIsafeSignatureVerifierFormat(
  signature: Hex
): DecodedEip1271Signature | null {
  // PayloadStruct starts at byte offset 548 (length word) + 32 (length itself)
  const PAYLOAD_LEN_OFFSET = 4 + 32 + 32 + 64 + 32 + GPV2_ORDER_BYTES; // = 548

  const payloadLenHex = signature.slice(
    2 + PAYLOAD_LEN_OFFSET * 2,
    2 + (PAYLOAD_LEN_OFFSET + 32) * 2
  );
  const payloadLen = Number(BigInt("0x" + payloadLenHex));
  const payloadStart = 2 + (PAYLOAD_LEN_OFFSET + 32) * 2;
  const payloadHex = `0x${signature.slice(payloadStart, payloadStart + payloadLen * 2)}` as Hex;

  const [decoded] = decodeAbiParameters(PAYLOAD_STRUCT_ABI, payloadHex);
  return extractFields(decoded);
}

/**
 * Format B: ERC1271Forwarder (CoWShedForComposableCoW and other non-Safe ERC1271)
 *
 * Byte layout: abi.encode(GPv2Order.Data, PayloadStruct)
 *   0–383   GPv2Order.Data (12 fixed-size fields, 384 bytes total)
 *   384–N   abi.encode(PayloadStruct)
 */
function decodeErc1271ForwarderFormat(
  signature: Hex
): DecodedEip1271Signature | null {
  const payloadHex = `0x${signature.slice(2 + GPV2_ORDER_BYTES * 2)}` as Hex;

  const [decoded] = decodeAbiParameters(PAYLOAD_STRUCT_ABI, payloadHex);
  return extractFields(decoded);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFields(
  payload: { params: { handler: string; salt: Hex; staticInput: Hex }; proof: readonly Hex[]; offchainInput: Hex }
): DecodedEip1271Signature {
  return {
    handler: payload.params.handler.toLowerCase() as Hex,
    salt: payload.params.salt,
    staticInput: payload.params.staticInput,
    proof: payload.proof as Hex[],
    offchainInput: payload.offchainInput,
  };
}
