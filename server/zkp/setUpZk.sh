#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -e

# --- 1. SCRIPT ARGUMENT VALIDATION ---
DEPTH=$1
CANDIDATES=$2

# Check if both arguments are provided.
if [ -z "$DEPTH" ] || [ -z "$CANDIDATES" ]; then
    echo "Error: You must provide both Merkle Tree Depth and the Number of Candidates."
    echo "Usage: ./setUpZk.sh <depth> <candidates>"
    exit 1
fi

# --- 2. DEFINE VARIABLES BASED ON ARGUMENTS ---
# A single template file is now used, making the system more maintainable.
CIRCUIT_TEMPLATE_FILE="./circuits/VoteCheck.circom"
# Dynamically create names for build artifacts.
BUILD_DIR="./build_${DEPTH}_${CANDIDATES}"
VERIFIER_CONTRACT_NAME="Groth16Verifier_${DEPTH}_${CANDIDATES}"
VERIFIER_FILE="${VERIFIER_CONTRACT_NAME}.sol"
# The Powers of Tau file is a constant for a given curve and constraint size.
POT_FILE="powersOfTau28_hez_final_12.ptau"

echo "=========================================================="
echo "Starting ZKP setup for Depth: ${DEPTH}, Candidates: ${CANDIDATES}"
echo "=========================================================="

# --- 3. CREATE BUILD DIRECTORY ---
if [ ! -d "$BUILD_DIR" ]; then
    echo "-> Creating build directory: ${BUILD_DIR}"
    mkdir -p $BUILD_DIR
fi

# --- 4. DYNAMICALLY CONFIGURE AND COMPILE THE CIRCUIT ---
# This is a critical step for automation.
# It modifies the last line of the template to instantiate the circuit with the correct parameters.
echo "-> Configuring circuit template..."
# Create a temporary copy of the circuit to modify.
TEMP_CIRCUIT_FILE="${BUILD_DIR}/VoteCheck_temp.circom"
cp $CIRCUIT_TEMPLATE_FILE $TEMP_CIRCUIT_FILE
# Use `sed` to replace the main component instantiation line.
sed -i.bak "s/component main = .*/component main = Main(${DEPTH}, ${CANDIDATES});/g" $TEMP_CIRCUIT_FILE

echo "-> Compiling Circom circuit..."
# Compile the dynamically configured temporary circuit file.
circom $TEMP_CIRCUIT_FILE --r1cs --wasm --sym -o $BUILD_DIR

# --- 5. PREPARE FOR TRUSTED SETUP (PHASE 2) ---
if [ ! -f "$POT_FILE" ]; then
    echo "Error: Powers of Tau file ($POT_FILE) is missing. Please download it and place it in the zkp directory."
    exit 1
else
    echo "-> Found Powers of Tau file."
fi

# --- 6. GENERATE PROVING KEY (.zkey) ---
echo "-> Generating proving key (zkey)..."
snarkjs groth16 setup \
    "${BUILD_DIR}/VoteCheck_temp.r1cs" \
    "$POT_FILE" \
    "${BUILD_DIR}/circuit_0000.zkey"

# --- 7. CONTRIBUTE TO PHASE 2 CEREMONY ---
echo "-> Contributing to the ceremony..."
# In a real production environment, this would involve multiple independent contributors.
snarkjs zkey contribute \
    "${BUILD_DIR}/circuit_0000.zkey" \
    "${BUILD_DIR}/circuit_final.zkey" \
    --name="1st Contributor" -v -e="$(head -n 4096 /dev/urandom | openssl sha1)"

# --- 8. EXPORT VERIFICATION KEY ---
echo "-> Exporting verification key to JSON..."
snarkjs zkey export verificationkey \
    "${BUILD_DIR}/circuit_final.zkey" \
    "${BUILD_DIR}/verification_key.json"

# --- 9. EXPORT VERIFIER SMART CONTRACT ---
echo "-> Exporting Verifier contract..."
snarkjs zkey export solidityverifier \
    "${BUILD_DIR}/circuit_final.zkey" \
    "${BUILD_DIR}/${VERIFIER_FILE}"

# --- 10. FINALIZE AND MOVE THE VERIFIER CONTRACT ---
echo "-> Renaming contract inside the .sol file..."
# `snarkjs` always names the contract `Groth16Verifier`. This renames it to match our unique filename.
sed -i.bak "s/contract Groth16Verifier/contract ${VERIFIER_CONTRACT_NAME}/g" "${BUILD_DIR}/${VERIFIER_FILE}"
rm "${BUILD_DIR}/${VERIFIER_FILE}.bak" 

echo "-> Moving Verifier contract to the contracts directory..."
# Move the finalized contract to the main contracts folder for Hardhat to use.
mv "${BUILD_DIR}/${VERIFIER_FILE}" "../../contracts/"

echo "=========================================================="
echo "ZKP setup complete for ${VERIFIER_CONTRACT_NAME}!"
echo "=========================================================="