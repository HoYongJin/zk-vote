/**
 * @file frontend/src/workers/proof.worker.ts
 * @desc Runs as a dedicated Web Worker. Executes the CPU-heavy ZK-SNARK proof
 * generation (`snarkjs.groth16.fullProve`) off the main UI thread.
 */
import * as snarkjs from 'snarkjs';
import type { WorkerRequest, WorkerResponse } from './proof.types';

// The worker global scope is typed minimally here so the app can keep the DOM
// lib without pulling in the WebWorker lib (they declare conflicting globals).
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

ctx.onmessage = async (event) => {
  // Preferred: integrity-verified in-memory artifacts (wasmData/zkeyData,
  // AR-M6). Legacy fallback: URLs for pre-manifest elections.
  const { inputs, wasmPath, zkeyPath, wasmData, zkeyData } = event.data;

  const wasmInput = wasmData ? { type: 'mem' as const, data: wasmData } : wasmPath;
  const zkeyInput = zkeyData ? { type: 'mem' as const, data: zkeyData } : zkeyPath;

  if (!wasmInput || !zkeyInput) {
    ctx.postMessage({ status: 'error', message: '증명 아티팩트(wasm/zkey)가 누락되었습니다.' });
    return;
  }

  console.log('[ZK Worker] Received job. Starting proof generation...');
  console.log(`[ZK Worker] WASM: ${wasmData ? `verified in-memory (${wasmData.length} bytes)` : wasmPath}`);
  console.log(`[ZK Worker] ZKey: ${zkeyData ? `verified in-memory (${zkeyData.length} bytes)` : zkeyPath}`);

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmInput, zkeyInput);
    ctx.postMessage({ status: 'success', proof, publicSignals });
    console.log('[ZK Worker] Proof generation successful. Result posted to main thread.');
  } catch (error) {
    console.error('[ZK Worker] Proof generation failed:', error);
    ctx.postMessage({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
