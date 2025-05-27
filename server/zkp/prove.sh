# #!/bin/bash
# set -e

# CIRCUIT=VoteCheck
# BUILD_DIR="./build"
# TMP_DIR="./tmp"

# # 1. UUID 세션 생성
# # SESSION_ID=$(uuidgen)
# SESSION_ID=${SESSION_ID:?SESSION_ID 환경변수가 필요합니다}
# SESSION_PATH="$TMP_DIR/$SESSION_ID"

# mkdir -p $SESSION_PATH

# INPUT_FILE="$SESSION_PATH/input.json"
# WITNESS_FILE="$SESSION_PATH/witness.wtns"
# PROOF_FILE="$SESSION_PATH/proof.json"
# PUBLIC_FILE="$SESSION_PATH/public.json"

# echo "🌀 증명 시작: 세션 $SESSION_ID"

# # 2. input.json 있는지 확인
# if [ ! -f "$INPUT_FILE" ]; then
#     echo "❌ $INPUT_FILE 없음. 먼저 input.json 저장해야 함."
#     exit 1
# fi

# # 3. witness 생성
# echo "📄 witness 생성"
# node $BUILD_DIR/${CIRCUIT}_js/generate_witness.js \
#      $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm \
#      $INPUT_FILE \
#      $WITNESS_FILE

# # 4. proof 생성
# echo "🧾 proof 생성"
# npx snarkjs groth16 prove \
#     $BUILD_DIR/circuit_final.zkey \
#     $WITNESS_FILE \
#     $PROOF_FILE \
#     $PUBLIC_FILE

# echo "✅ 증명 완료! 세션 $SESSION_ID 결과 저장됨: $SESSION_PATH"

# # 5. 결과 경로 출력 (Node.js에서 사용 가능)
# echo $SESSION_PATH


#!/bin/bash
set -e

CIRCUIT=VoteCheck
BUILD_DIR="./build"
TMP_DIR="./tmp"

SESSION_ID=$1
SESSION_PATH="$TMP_DIR/$SESSION_ID"

INPUT_FILE="$SESSION_PATH/input.json"
WITNESS_FILE="$SESSION_PATH/witness.wtns"
PROOF_FILE="$SESSION_PATH/proof.json"
PUBLIC_FILE="$SESSION_PATH/public.json"

echo "증명 시작 (세션 $SESSION_ID)"

node $BUILD_DIR/${CIRCUIT}_js/generate_witness.js \
  $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm \
  $INPUT_FILE \
  $WITNESS_FILE

echo "1차 완료"

npx snarkjs groth16 prove \
  $BUILD_DIR/circuit_final.zkey \
  $WITNESS_FILE \
  $PROOF_FILE \
  $PUBLIC_FILE

echo "2차 완료"

echo "증명 완료: $SESSION_ID"
