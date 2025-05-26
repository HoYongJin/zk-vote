#!/bin/bash
set -e

CIRCUIT=VoteCheck
BUILD_DIR="./build"
INPUT_DIR="./input"
POT_FILE="powersOfTau28_hez_final_12.ptau"

echo "📦 ZKP 컴파일 시작: $CIRCUIT"
echo "=========================================="

# 0. build 디렉토리 생성
if [ ! -d "$BUILD_DIR" ]; then
    echo "📂 [0] build 디렉토리 생성"
    mkdir -p $BUILD_DIR
fi

# 1. Circom 컴파일
echo "🧱 [1] Circom 회로 컴파일 중..."
circom circuits/$CIRCUIT.circom --r1cs --wasm --sym -o $BUILD_DIR

# 2. Powers of Tau 파일 체크
if [ ! -f $POT_FILE ]; then
    echo "❌ [오류] 루트 디렉토리에 $POT_FILE 파일이 없습니다."
    echo "루트 디렉토리에 $POT_FILE 파일을 준비해 주세요."
    exit 1
else
    echo "✅ [2] 기존 $POT_FILE 파일 사용"
fi

# (build 폴더로 ptau 복사)
cp $POT_FILE $BUILD_DIR/$POT_FILE

# 3. proving key (zkey) 생성
echo "🔐 [3] proving key (zkey) 생성 중..."
snarkjs groth16 setup $BUILD_DIR/$CIRCUIT.r1cs $BUILD_DIR/$POT_FILE $BUILD_DIR/circuit_0000.zkey

# 4. Phase 2 기여 (엔트로피 입력)
echo "🎁 [4] Phase 2 기여 (엔트로피 입력)"
snarkjs zkey contribute $BUILD_DIR/circuit_0000.zkey $BUILD_DIR/circuit_final.zkey --name="1st Contributor" -v

# 5. Verification key 생성
echo "🔎 [5] verification key 저장"
snarkjs zkey export verificationkey $BUILD_DIR/circuit_final.zkey $BUILD_DIR/verification_key.json

# 6. Verifier.sol 생성
echo "🧾 [6] Verifier.sol 생성"
snarkjs zkey export solidityverifier $BUILD_DIR/circuit_final.zkey $BUILD_DIR/Verifier.sol

# 7. input.json 체크
if [ ! -f $INPUT_DIR/input.json ]; then
    echo "❌ [오류] $INPUT_DIR/input.json 파일이 없습니다."
    echo "input 디렉토리에 input.json을 준비해 주세요."
    exit 1
else
    echo "✅ [7] input.json 파일 존재 확인"
fi

# 8. witness.wtns 생성
echo "📄 [8] witness.wtns 생성 (input.json 사용)"
node $BUILD_DIR/${CIRCUIT}_js/generate_witness.js $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm $INPUT_DIR/input.json $BUILD_DIR/witness.wtns

# 9. proof.json, public.json 생성
echo "🧾 [9] proof.json, public.json 생성"
snarkjs groth16 prove $BUILD_DIR/circuit_final.zkey $BUILD_DIR/witness.wtns $BUILD_DIR/proof.json $BUILD_DIR/public.json

echo "✅ 모든 과정 완료!"
