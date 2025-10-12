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
# Construct the absolute path to the circomlib directory from the script's location.
CIRCOMLIB_PATH="${SCRIPT_DIR}/../node_modules/circomlib/circuits"

echo "-> Dynamically determined circomlib path: ${CIRCOMLIB_PATH}"

# --- 2. DYNAMICALLY SELECT PTAU FILE BASED ON DEPTH ---
echo "-> Selecting appropriate Powers of Tau file for depth ${DEPTH}..."
PTAU_FILE="" # Initialize variable

if [ "$DEPTH" -le 5 ]; then
    PTAU_FILE="powersOfTau28_hez_final_12.ptau"
# depth가 6이상 10 이하일 경우, _16.ptau 파일을 사용합니다.
elif [ "$DEPTH" -le 10 ]; then
    PTAU_FILE="powersOfTau28_hez_final_16.ptau"
# depth가 11 이상 20 이하일 경우, _20.ptau 파일을 사용합니다.
elif [ "$DEPTH" -le 20 ]; then
    PTAU_FILE="powersOfTau28_hez_final_20.ptau"
else
    # 20을 초과하는 경우에 대한 에러 처리
    echo "Error: Merkle tree depth ${DEPTH} is too large for available .ptau files."
    echo "Please download a larger Powers of Tau file and update this script."
    exit 1
fi

echo "-> Using: ${PTAU_FILE}"

# --- 3. DEFINE VARIABLES BASED ON ARGUMENTS ---
CIRCUIT_TEMPLATE_FILE="./circuits/VoteCheck.circom"
BUILD_DIR="./build_${DEPTH}_${CANDIDATES}"
VERIFIER_CONTRACT_NAME="Groth16Verifier_${DEPTH}_${CANDIDATES}"
VERIFIER_FILE="${VERIFIER_CONTRACT_NAME}.sol"

echo "=========================================================="
echo "Starting ZKP setup for Depth: ${DEPTH}, Candidates: ${CANDIDATES}"
echo "=========================================================="

# --- 4. CREATE BUILD DIRECTORY ---
if [ ! -d "$BUILD_DIR" ]; then
    echo "-> Creating build directory: ${BUILD_DIR}"
    mkdir -p $BUILD_DIR
fi

# --- 5. DYNAMICALLY CONFIGURE AND COMPILE THE CIRCUIT ---
echo "-> Configuring and compiling circuit..."
TEMP_CIRCUIT_FILE="${BUILD_DIR}/VoteCheck_temp.circom"
cp $CIRCUIT_TEMPLATE_FILE $TEMP_CIRCUIT_FILE
sed -i.bak "s/component main = .*/component main = Main(${DEPTH}, ${CANDIDATES});/g" $TEMP_CIRCUIT_FILE
rm "${TEMP_CIRCUIT_FILE}.bak"

#/home/ubuntu/.cargo/bin/circom $TEMP_CIRCUIT_FILE --r1cs --wasm --sym -o $BUILD_DIR -l ../node_modules/circomlib/circuits
/home/ubuntu/.cargo/bin/circom $TEMP_CIRCUIT_FILE --r1cs --wasm --sym -o $BUILD_DIR -l "$CIRCOMLIB_PATH"

# --- 6. CHECK FOR AND USE THE SELECTED PTAU FILE ---
if [ ! -f "$PTAU_FILE" ]; then
    echo "Error: Powers of Tau file ($PTAU_FILE) is missing."
    echo "Please download it and place it in the zkp directory."
    exit 1
fi

# --- 7. GENERATE PROVING KEY (.zkey) ---
echo "-> Generating proving key (zkey)..."
snarkjs groth16 setup \
    "${BUILD_DIR}/VoteCheck_temp.r1cs" \
    "$PTAU_FILE" \
    "${BUILD_DIR}/circuit_0000.zkey"

# --- 8. CONTRIBUTE TO PHASE 2 CEREMONY ---
echo "-> Contributing to the ceremony..."
snarkjs zkey contribute \
    "${BUILD_DIR}/circuit_0000.zkey" \
    "${BUILD_DIR}/circuit_final.zkey" \
    --name="1st Contributor" -v -e="$(head -n 4096 /dev/urandom | openssl sha1)"

# --- 9. EXPORT VERIFICATION KEY & CONTRACT ---
echo "-> Exporting verification key and contract..."
snarkjs zkey export verificationkey "${BUILD_DIR}/circuit_final.zkey" "${BUILD_DIR}/verification_key.json"
snarkjs zkey export solidityverifier "${BUILD_DIR}/circuit_final.zkey" "${BUILD_DIR}/${VERIFIER_FILE}"

# --- 10. FINALIZE AND MOVE THE VERIFIER CONTRACT ---
echo "-> Finalizing and moving the Verifier contract..."
sed -i.bak "s/contract Groth16Verifier/contract ${VERIFIER_CONTRACT_NAME}/g" "${BUILD_DIR}/${VERIFIER_FILE}"
rm "${BUILD_DIR}/${VERIFIER_FILE}.bak" 
mv "${BUILD_DIR}/${VERIFIER_FILE}" "../../contracts/"

echo "=========================================================="
echo "ZKP setup complete for ${VERIFIER_CONTRACT_NAME}!"
echo "=========================================================="