#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -e

# --- 1. SCRIPT ARGUMENT VALIDATION ---
DEPTH=$1
CANDIDATES=$2

if [ -z "$DEPTH" ] || [ -z "$CANDIDATES" ]; then
    echo "Error: You must provide both Merkle Tree Depth and the Number of Candidates."
    echo "Usage: ./setUpZk.sh <depth> <candidates>"
    exit 1
fi

# --- NEW: Dynamically determine absolute paths ---
# Get the absolute path of the directory where this script is located.
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
# zk/ sits directly under the repo root, so the project root is one level up.
PROJECT_ROOT=$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )
# Construct the absolute path to the circomlib directory from the script's location.
CIRCOMLIB_PATH="${SCRIPT_DIR}/../node_modules/circomlib/circuits"
CIRCOM_BIN="${CIRCOM_BIN:-circom}"
SNARKJS_BIN="${SNARKJS_BIN:-${PROJECT_ROOT}/node_modules/.bin/snarkjs}"

if [ ! -x "$SNARKJS_BIN" ]; then
    SNARKJS_BIN="${SCRIPT_DIR}/../node_modules/.bin/snarkjs"
fi

echo "-> Dynamically determined circomlib path: ${CIRCOMLIB_PATH}"
echo "-> Using circom binary: ${CIRCOM_BIN}"
echo "-> Using snarkjs binary: ${SNARKJS_BIN}"

# --- 2. DYNAMICALLY SELECT PTAU FILE BASED ON DEPTH ---
echo "-> Selecting appropriate Powers of Tau file for depth ${DEPTH}..."
PTAU_FILE_NAME="" # Initialize variable

if [ "$DEPTH" -le 5 ]; then
    PTAU_FILE_NAME="powersOfTau28_hez_final_12.ptau"
# depth가 6이상 10 이하일 경우, _16.ptau 파일을 사용합니다.
elif [ "$DEPTH" -le 10 ]; then
    PTAU_FILE_NAME="powersOfTau28_hez_final_16.ptau"
# depth가 11 이상 20 이하일 경우, _20.ptau 파일을 사용합니다.
elif [ "$DEPTH" -le 20 ]; then
    PTAU_FILE_NAME="powersOfTau28_hez_final_20.ptau"
else
    # 20을 초과하는 경우에 대한 에러 처리
    echo "Error: Merkle tree depth ${DEPTH} is too large for available .ptau files."
    echo "Please download a larger Powers of Tau file and update this script."
    exit 1
fi

PTAU_FILE="${SCRIPT_DIR}/${PTAU_FILE_NAME}"
echo "-> Using: ${PTAU_FILE}"

# --- 3. DEFINE VARIABLES BASED ON ARGUMENTS ---
CIRCUIT_TEMPLATE_FILE="${SCRIPT_DIR}/circuits/VoteCheck.circom"
BUILD_DIR="${SCRIPT_DIR}/build_${DEPTH}_${CANDIDATES}"
VERIFIER_CONTRACT_NAME="Groth16Verifier_${DEPTH}_${CANDIDATES}"
VERIFIER_FILE="${VERIFIER_CONTRACT_NAME}.sol"

echo "=========================================================="
echo "Starting ZKP setup for Depth: ${DEPTH}, Candidates: ${CANDIDATES}"
echo "=========================================================="

# --- 4. CREATE BUILD DIRECTORY ---
if [ ! -d "$BUILD_DIR" ]; then
    echo "-> Creating build directory: ${BUILD_DIR}"
    mkdir -p "$BUILD_DIR"
fi

# --- 5. DYNAMICALLY CONFIGURE AND COMPILE THE CIRCUIT ---
echo "-> Configuring and compiling circuit..."
TEMP_CIRCUIT_FILE="${BUILD_DIR}/VoteCheck_temp.circom"
cp "$CIRCUIT_TEMPLATE_FILE" "$TEMP_CIRCUIT_FILE"
# Rewrite only the Main(depth, candidates) arguments while preserving the
# `{public [election_id]}` declaration that exposes election_id as a public
# signal (audit C1). The greedy match replaces the whole instantiation line so
# the canonical public declaration is always re-emitted regardless of the
# template's literal arguments.
sed -i.bak "s|component main.*= Main(.*|component main {public [election_id]} = Main(${DEPTH}, ${CANDIDATES});|g" "$TEMP_CIRCUIT_FILE"
rm "${TEMP_CIRCUIT_FILE}.bak"

"$CIRCOM_BIN" "$TEMP_CIRCUIT_FILE" --r1cs --wasm --sym -o "$BUILD_DIR" -l "$CIRCOMLIB_PATH"

# --- 6. CHECK FOR AND USE THE SELECTED PTAU FILE ---
if [ ! -f "$PTAU_FILE" ]; then
    echo "Error: Powers of Tau file ($PTAU_FILE) is missing."
    echo "Please download it and place it in the zkp directory."
    exit 1
fi

# --- 7. GENERATE PROVING KEY (.zkey) ---
echo "-> Generating proving key (zkey)..."
"$SNARKJS_BIN" groth16 setup \
    "${BUILD_DIR}/VoteCheck_temp.r1cs" \
    "$PTAU_FILE" \
    "${BUILD_DIR}/circuit_0000.zkey"

# --- 8. CONTRIBUTE TO PHASE 2 CEREMONY ---
echo "-> Contributing to the ceremony..."
"$SNARKJS_BIN" zkey contribute \
    "${BUILD_DIR}/circuit_0000.zkey" \
    "${BUILD_DIR}/circuit_0001.zkey" \
    --name="1st Contributor" -v -e="$(head -n 4096 /dev/urandom | openssl sha1)"

# --- 8b. FINALIZE WITH A PUBLIC RANDOM BEACON (architecture review AR-H1) ---
# A single operator-run contribution lets whoever knows its entropy forge
# proofs. Finalizing with a PUBLIC beacon value (e.g. a published drand round
# or a future block hash, supplied as BEACON_HEX) removes that trust:
# anyone can re-verify the transcript. Production elections MUST be
# generated with BEACON_HEX set; local dev may omit it, and the artifact
# manifest records which mode produced the zkey.
if [ -n "${BEACON_HEX:-}" ]; then
    echo "-> Finalizing zkey with public beacon ${BEACON_HEX:0:16}..."
    "$SNARKJS_BIN" zkey beacon \
        "${BUILD_DIR}/circuit_0001.zkey" \
        "${BUILD_DIR}/circuit_final.zkey" \
        "${BEACON_HEX}" 10 -n="Final beacon"
    echo "{\"finalizedWithBeacon\": true, \"beaconHex\": \"${BEACON_HEX}\"}" > "${BUILD_DIR}/ceremony.json"
else
    echo "-> WARNING: no BEACON_HEX set — dev-only zkey (NOT acceptable for production, AR-H1)."
    mv "${BUILD_DIR}/circuit_0001.zkey" "${BUILD_DIR}/circuit_final.zkey"
    echo '{"finalizedWithBeacon": false}' > "${BUILD_DIR}/ceremony.json"
fi

# --- 8c. VERIFY THE CEREMONY TRANSCRIPT (gate) ---
echo "-> Verifying the zkey transcript against the circuit and ptau..."
"$SNARKJS_BIN" zkey verify \
    "${BUILD_DIR}/VoteCheck_temp.r1cs" \
    "$PTAU_FILE" \
    "${BUILD_DIR}/circuit_final.zkey"

# --- 9. EXPORT VERIFICATION KEY & CONTRACT ---
echo "-> Exporting verification key and contract..."
"$SNARKJS_BIN" zkey export verificationkey "${BUILD_DIR}/circuit_final.zkey" "${BUILD_DIR}/verification_key.json"
"$SNARKJS_BIN" zkey export solidityverifier "${BUILD_DIR}/circuit_final.zkey" "${BUILD_DIR}/${VERIFIER_FILE}"

# --- 10. FINALIZE AND MOVE THE VERIFIER CONTRACT ---
echo "-> Finalizing and moving the Verifier contract..."
sed -i.bak "s/contract Groth16Verifier/contract ${VERIFIER_CONTRACT_NAME}/g" "${BUILD_DIR}/${VERIFIER_FILE}"
rm "${BUILD_DIR}/${VERIFIER_FILE}.bak" 
mv "${BUILD_DIR}/${VERIFIER_FILE}" "${PROJECT_ROOT}/contracts/"

echo "=========================================================="
echo "ZKP setup complete for ${VERIFIER_CONTRACT_NAME}!"
echo "=========================================================="
