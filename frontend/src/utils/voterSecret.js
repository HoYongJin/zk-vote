// poseidon-lite is generated from the circomlib Poseidon constants, so its
// output is bit-identical to the circomlibjs Poseidon the backend uses for
// Merkle leaves (cross-checked in test/poseidonCompat.js). circomlibjs itself
// cannot be bundled by CRA/webpack 5 (it imports Node builtins like `assert`).
import { poseidon1 } from 'poseidon-lite';

const SECRET_KEY_PREFIX = 'zkvote_secret_';

function secretStorageKey(electionId) {
  return `${SECRET_KEY_PREFIX}${electionId}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateSecret() {
  const bytes = new Uint8Array(31);
  window.crypto.getRandomValues(bytes);
  const secret = BigInt(`0x${bytesToHex(bytes)}`);
  if (secret === 0n) {
    return generateSecret();
  }
  return secret.toString();
}

function getStoredVoterSecret(electionId) {
  const secret = window.localStorage.getItem(secretStorageKey(electionId));
  if (!secret || !/^[0-9]+$/.test(secret)) {
    return null;
  }
  return secret;
}

function saveVoterSecret(electionId, secret) {
  window.localStorage.setItem(secretStorageKey(electionId), secret);
}

function removeVoterSecret(electionId) {
  window.localStorage.removeItem(secretStorageKey(electionId));
}

export function getOrCreateVoterSecret(electionId) {
  const existing = getStoredVoterSecret(electionId);
  if (existing) {
    return existing;
  }

  const secret = generateSecret();
  saveVoterSecret(electionId, secret);
  return secret;
}

export function getVoterSecret(electionId) {
  return getStoredVoterSecret(electionId);
}

export function clearVoterSecret(electionId) {
  removeVoterSecret(electionId);
}

export async function calculateSecretCommitment(secret) {
  return poseidon1([BigInt(secret)]).toString();
}
