/**
 * @file frontend/src/workers/proof.worker.js
 * @desc This script runs as a Web Worker in a separate background thread.
 * Its sole purpose is to execute the computationally expensive ZK-SNARK
 * proof generation (`snarkjs.groth16.fullProve`) without freezing the main
 * browser UI thread.
 */

/* eslint-env worker */ // Tells ESLint this is a Web Worker environment

// Import the snarkjs library into the worker's scope
import * as snarkjs from 'snarkjs';

/**
 * Handles messages sent from the main UI thread (e.g., VotePage.js).
 * This function is the entry point for the worker.
 *
 * @param {MessageEvent} event - The event object containing data from the main thread.
 * @param {object} event.data - The data payload.
 * @param {object} event.data.inputs - The private and public inputs for the ZK circuit.
 * @param {string} event.data.wasmPath - The path to the compiled circuit's .wasm file.
 * @param {string} event.data.zkeyPath - The path to the circuit's final .zkey (proving key).
 */
self.onmessage = async (event) => {
    // Extract data from the main thread's message. Preferred: integrity
    // verified in-memory artifacts (wasmData/zkeyData, AR-M6); legacy
    // fallback: URLs for pre-manifest elections.
    const { inputs, wasmPath, zkeyPath, wasmData, zkeyData } = event.data;

    const wasmInput = wasmData ? { type: 'mem', data: wasmData } : wasmPath;
    const zkeyInput = zkeyData ? { type: 'mem', data: zkeyData } : zkeyPath;

    console.log(`[ZK Worker] Received job. Starting proof generation...`);
    console.log(`[ZK Worker] WASM: ${wasmData ? `verified in-memory (${wasmData.length} bytes)` : wasmPath}`);
    console.log(`[ZK Worker] ZKey: ${zkeyData ? `verified in-memory (${zkeyData.length} bytes)` : zkeyPath}`);

    try {
        // --- Heavy Computation ---
        // This is the core, CPU-intensive task.
        // It runs in this background thread, leaving the UI responsive.
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,    // The circuit inputs (private + public)
        wasmInput, // Verified bytes or path to the .wasm file
        zkeyInput  // Verified bytes or path to the .zkey file
    );
    // --- Computation Complete ---

    // Send the successful result back to the main thread.
    self.postMessage({ 
      status: 'success', 
      proof, 
      publicSignals
    });
    
    console.log("[ZK Worker] Proof generation successful. Result posted to main thread.");

    } catch (error) {
        // If snarkjs.groth16.fullProve fails (e.g., bad inputs, file not found),
        // catch the error and send an error message back to the main thread.
        console.error("[ZK Worker] Proof generation failed:", error);
        self.postMessage({ 
        status: 'error', 
        message: error.message // Send the error message for debugging
        });
    }
};