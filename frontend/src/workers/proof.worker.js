/* eslint-env worker */ 

// snarkjs 라이브러리를 워커 스크립트로 가져옵니다.
import * as snarkjs from 'snarkjs';

// 메인 스레드로부터 메시지를 받으면 이 함수가 실행됩니다.
self.onmessage = async (event) => {
  // 메인 스레드가 보낸 데이터(입력값, 파일 경로)를 추출합니다.
  const { inputs, wasmPath, zkeyPath } = event.data;
  console.log("Web Worker: 증명 생성을 시작합니다.");

  try {
    // 백그라운드에서 무거운 ZKP 생성 작업을 수행합니다.
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);

    // 작업이 성공하면 결과를 다시 메인 스레드로 보냅니다.
    self.postMessage({ status: 'success', proof, publicSignals });
    console.log("Web Worker: 증명 생성을 완료하고 결과를 보냈습니다.");

  } catch (error) {
    // 작업 중 오류가 발생하면 오류 메시지를 보냅니다.
    self.postMessage({ status: 'error', message: error.message });
    console.error("Web Worker: 증명 생성 중 오류 발생:", error);
  }
};