/**
 * @file frontend/src/utils/artifactIntegrity.js
 * @desc Client-side integrity verification of the proving artifacts
 * (architecture review AR-M6). The wasm/zkey fed to the prover handle the
 * voter's plaintext secret; a tampered artifact could exfiltrate it or
 * produce poisoned proofs, so the browser refuses to prove when the served
 * bytes do not hash to the deploy-time manifest values (audit M5).
 */

export async function sha256Hex(buffer) {
  const digest = await window.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Downloads `url` and verifies its SHA-256 against `expectedSha256`.
 * @returns {Promise<Uint8Array>} the verified bytes.
 * @throws when the fetch fails or the hash does not match.
 */
export async function fetchVerifiedArtifact(url, expectedSha256, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} 다운로드에 실패했습니다 (HTTP ${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  const actual = await sha256Hex(buffer);
  if (!expectedSha256 || actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `${label} 무결성 검증에 실패했습니다. 서버가 배포 시점과 다른 증명 아티팩트를 제공하고 있습니다. 투표를 중단합니다.`
    );
  }
  return new Uint8Array(buffer);
}
