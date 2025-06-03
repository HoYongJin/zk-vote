#!/bin/bash
set -e      # 오류 발생 시 즉시 종료

CIRCUIT=VoteCheck       # 회로 파일 이름 (VoteCheck.circom)
BUILD_DIR="./build"     # setUpZk.sh 결과 생성파일 저장 폴더
TMP_DIR="./tmp"         # 각 증명 세션별 임시 작업 디렉토리

SESSION_ID=$1                           # 사용자로부터 증명 세션 ID를 인자로 받음
SESSION_PATH="$TMP_DIR/$SESSION_ID"     # 해당 세션을 위한 임시 디렉토리 경로

INPUT_FILE="$SESSION_PATH/input.json"           # input.json : 회로에 입력될 실제 데이터
WITNESS_FILE="$SESSION_PATH/witness.wtns"       # witness.wtns : 회로 입력값을 바탕으로 계산된 중간 산출물
PROOF_FILE="$SESSION_PATH/proof.json"           # proof.json : 최종적으로 생성되는 ZK 증명 데이터
PUBLIC_FILE="$SESSION_PATH/public.json"         # public.json : 회로의 public input 값들

# 증명 생성 과정 시작
echo "Proof generation started(session: $SESSION_ID)"

# 1. Witness 생성
# Circom에서 컴파일된 .wasm 파일과 input.json을 바탕으로
# 내부 중간 계산 결과인 witness.wtns 파일을 생성한다.
node $BUILD_DIR/${CIRCUIT}_js/generate_witness.js \
    $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm \
    $INPUT_FILE \
    $WITNESS_FILE

echo "Witness generated"

# 2. zk-SNARK 증명 생성
# 위에서 생성된 witness.wtns와 proving key (circuit_final.zkey)를 바탕으로
# zk-SNARK 증명(proof.json)과 공개 입력(public.json)을 생성한다.
npx snarkjs groth16 prove \
  $BUILD_DIR/circuit_final.zkey \
  $WITNESS_FILE \
  $PROOF_FILE \
  $PUBLIC_FILE

echo "Proof generated"

echo "Proof completed successfully(session: $SESSION_ID)"
