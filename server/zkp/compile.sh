#!/bin/bash
set -e

CIRCUIT=VoteCheck
CIRCUIT_FILE="./circuits/${CIRCUIT}.circom"
BUILD_DIR="./build"
POT_FILE="powersOfTau28_hez_final_12.ptau"

echo "📦 ZKP 회로 컴파일 및 Verifier 생성 시작"
echo "=========================================="

# 0. build 디렉토리 생성
if [ ! -d "$BUILD_DIR" ]; then
    echo "📂 build 디렉토리 생성"
    mkdir -p $BUILD_DIR
fi

# 1. Circom 컴파일
echo "🧱 Circom 회로 컴파일 중..."
circom $CIRCUIT_FILE --r1cs --wasm --sym -o $BUILD_DIR

# 2. ptau 파일 확인
if [ ! -f "$POT_FILE" ]; then
    echo "❌ ptau 파일($POT_FILE)이 없습니다. 루트에 파일을 두세요."
    exit 1
else
    echo "✅ ptau 파일 확인 완료"
    cp $POT_FILE $BUILD_DIR/$POT_FILE
fi

# 3. proving key 생성
echo "🔐 proving key 생성 중..."
snarkjs groth16 setup $BUILD_DIR/${CIRCUIT}.r1cs $BUILD_DIR/$POT_FILE $BUILD_DIR/circuit_0000.zkey

# 4. phase 2 기여
echo "🎁 phase 2 기여"
snarkjs zkey contribute $BUILD_DIR/circuit_0000.zkey $BUILD_DIR/circuit_final.zkey --name="1st Contributor" -v

# 5. verification key
echo "🔎 verification key 생성"
snarkjs zkey export verificationkey $BUILD_DIR/circuit_final.zkey $BUILD_DIR/verification_key.json

# 6. Verifier.sol 생성
echo "🧾 Verifier.sol 생성"
snarkjs zkey export solidityverifier $BUILD_DIR/circuit_final.zkey $BUILD_DIR/Verifier.sol

echo "✅ 모든 컴파일 완료!"
