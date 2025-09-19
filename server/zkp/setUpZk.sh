#!/bin/bash
set -e      # 오류 발생 시 즉시 종료

DEPTH=$1

if [ -z "$DEPTH" ]; then
    echo "오류: Merkle Tree 높이를 인자로 제공해야 합니다"
    exit 1
fi

CIRCUIT="VoteCheck_${DEPTH}"                        # 회로 파일 이름 (VoteCheck_depth.circom)
CIRCUIT_FILE="./circuits/${CIRCUIT}.circom"         # Circom 회로 경로
BUILD_DIR="./build_${DEPTH}"                         # 생성파일 저장 폴더
VERIFIER_FILE="Groth16Verifier_${DEPTH}.sol"        # 검증 스마트 컨트랙트
POT_FILE="powersOfTau28_hez_final_12.ptau"          # zk-SNARKs 회로를 컴파일하고 증명을 생성하기 위해 필요한 초기 파라미터 파일

echo "Starting ZKP circuit compilation and verifier generation(Depth: ${DEPTH})"
echo "=========================================="

# 0. build 디렉토리 생성
if [ ! -d "$BUILD_DIR" ]; then
    echo "Creating build directory"
    mkdir -p $BUILD_DIR
fi


# 1. Circom 컴파일
# - VoteCheck.r1cs: 회로의 제약 조건을 압축한 바이너리 파일
# - VoteCheck.wasm: witness를 생성하기 위한 WebAssembly 코드
# - VoteCheck.sym: Circom 변수 이름과 R1CS 인덱스 매핑 파일
echo "Compiling Circom circuit..."
circom $CIRCUIT_FILE --r1cs --wasm --sym -o $BUILD_DIR


# 2. ptau 파일 확인(zk-SNARKs의 "trusted setup" 중 1단계 결과물 (Phase 1))
if [ ! -f "$POT_FILE" ]; then
    echo "ptau file ($POT_FILE) is missing. Please place it in the project root"
    exit 1
else
    echo "ptau file found"
    cp $POT_FILE $BUILD_DIR/$POT_FILE
fi


# 3. proving key 생성 (Phase 2 시작: proving key(.zkey) 파일 생성)
# circuit_0000.zkey: proving/verifying key의 초기 상태
echo "Generating proving key..."
snarkjs groth16 setup \
    $BUILD_DIR/${CIRCUIT}.r1cs \
    $BUILD_DIR/$POT_FILE \
    $BUILD_DIR/circuit_0000.zkey


# 4. phase 2 기여(.zkey에 서명하여 신뢰된 환경에서 만든 것을 보장)
# circuit_final.zkey: 실제 증명에 사용하는 최종 proving key(생성자가 누구인지, 랜덤 기여가 적용됐는지 포함)
echo "Contributing to phase 2"
snarkjs zkey contribute \
    $BUILD_DIR/circuit_0000.zkey \
    $BUILD_DIR/circuit_final.zkey \
    --name="1st Contributor" -v


# 5. verification key
# verification_key.json: zk-SNARKs 증명을 검증할 때 필요한 공개 키
echo "Exporting verification key"
snarkjs zkey export verificationkey \
    $BUILD_DIR/circuit_final.zkey \
    $BUILD_DIR/verification_key.json


# 6. Verifier.sol 생성
# Verifier.sol: Solidity 기반 zk-SNARK 증명 검증 컨트랙트
echo "Exporting Verifier"
snarkjs zkey export solidityverifier \
    $BUILD_DIR/circuit_final.zkey \
    $BUILD_DIR/$VERIFIER_FILE

sed -i.bak "s/contract Groth16Verifier/contract ${VERIFIER_FILE%.sol}/g" "$BUILD_DIR/$VERIFIER_FILE"
rm "$BUILD_DIR/$VERIFIER_FILE.bak" 

mv "$BUILD_DIR/$VERIFIER_FILE" "../../contracts/"

echo "Compilation and setup complete!"
