pragma circom 2.0.0;

// Imports the Poseidon hash function from the circomlib library.
include "../circomlib/circuits/poseidon.circom";

/*
==========================================================================
 Template: MerkleProof
==========================================================================
* @purpose: Proves that a given `leaf` is a member of a Merkle tree with a given `root`.
* @principle: It reconstructs the Merkle root starting from the `leaf` using the provided `pathElements` 
             and `pathIndices`. The circuit constrains the calculated root to be equal to the public `root`.
* @param depth: The depth of the Merkle tree.
*/
template MerkleProof(depth) {
    // === INPUT SIGNALS ===
    // Private signals are known only to the prover. 
    // Public signals are known to both prover and verifier.
    signal input leaf;                          // Private: The hash of the user's secret, which is a leaf in the tree.
    signal input root;                          // Public: The known public root of the Merkle tree of registered voters.
    signal input pathElements[depth];           // Private: An array of sibling nodes along the path from the leaf to the root.
    signal input pathIndices[depth];            // Private: An array of 0s and 1s indicating if the node at each level is on the left (0) or right (1).

    // === INTERNAL SIGNALS ===
    // These signals are used for intermediate calculations within the circuit.
    signal left[depth];                         // Represents the left-child input for the hash at each level.
    signal right[depth];                        // Represents the right-child input for the hash at each level.

     // An array of hash components, one for each level of the tree.
    component hashers[depth];

    // An array to store the computed hash at each level, from the leaf up to the root.
    signal cur[depth + 1];

    // === LOGIC ===
    // 1. Start the computation from the leaf.
    cur[0] <== leaf;

    // 2. Iteratively compute the parent hash for each level of the tree.
    for (var i = 0; i < depth; i++) {
        // Determine the order of hashing based on `pathIndices[i]`.
        // If pathIndices[i] is 0, the current node `cur[i]` is the left child.
        // If pathIndices[i] is 1, the current node `cur[i]` is the right child.
        // The following lines implement this logic using arithmetic constraints, which are more efficient for circuits.
        left[i] <== (1 - pathIndices[i]) * cur[i] + pathIndices[i] * pathElements[i];
        right[i] <== pathIndices[i] * cur[i] + (1 - pathIndices[i]) * pathElements[i];

        // Initialize the Poseidon hasher for this level, configured for 2 inputs.
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        // The output of the hash becomes the input for the next level up.
        cur[i + 1] <== hashers[i].out;
    }
    // 3. Final Constraint: The final computed hash `cur[depth]` must equal the public `root`.
    cur[depth] === root;
}

/*
=====================================
 Template: VoteProof
=====================================
* @purpose: A comprehensive circuit that validates an entire voting action. It combines:
           1. Voter eligibility check (using MerkleProof).
           2. Vote format validation (ensuring a valid, single choice).
           3. Double-voting prevention (by generating a unique nullifier).
* @param depth: The depth of the voter Merkle tree.
* @param numOptions: The number of candidates or options in the election.
*/
template VoteProof(depth, numOptions) {
    // === INPUT SIGNALS ===
    signal input user_secret;               // Private: The voter's unique secret value.
    signal input vote[numOptions];          // Private: The vote cast, as a 1-hot encoded array (e.g., [0, 1, 0]).
    signal input pathElements[depth];       // Private: Merkle path elements for the voter's leaf.
    signal input pathIndices[depth];        // Private: Merkle path indices for the voter's leaf.
    signal input root;                      // Public: The Merkle root of the voter list.
    signal input election_id;               // Public: A unique identifier for the specific election.

    // === OUTPUT SIGNALS ===
    signal output vote_index;                // Public: The index of the candidate the user voted for.
    signal output nullifier_hash;            // Public: A unique value to prevent double-voting.

    // --- 1. PROVE VOTER ELIGIBILITY (using MerkleProof) ---

    // 1a. Generate the Merkle leaf by hashing the `user_secret`.
    // This proves membership without revealing the secret itself.
    component hasher = Poseidon(1);
    hasher.inputs[0] <== user_secret;
    signal leaf;
    leaf <== hasher.out;

    // 1b. Instantiate the MerkleProof circuit and connect its signals.
    // This enforces the constraint that the generated `leaf` belongs to the tree defined by `root`.
    component mp = MerkleProof(depth);
    mp.leaf <== leaf;
    mp.root <== root;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }

    // --- 2. VALIDATE THE VOTE FORMAT ---

    // 2a. Enforce that each element in the `vote` array is either 0 or 1.
    // The quadratic constraint `x * (1 - x) === 0` is satisfied only if x is 0 or 1.
    signal sum = 0;
    for (var i = 0; i < numOptions; i++) {
        vote[i] * (1 - vote[i]) === 0;
        sum += vote[i];
    }

    // 2b. Enforce that the sum of the `vote` array is exactly 1.
    // This ensures the voter has selected exactly one option (1-hot encoding).
    sum === 1;

    // --- 3. CALCULATE THE VOTE INDEX ---
    // Derives the chosen candidate's index from the 1-hot encoded array.
    signal temp_sum = 0;
    for (var i = 0; i < numOptions; i++) {
        temp_sum += vote[i] * i;
    }
    vote_index <== temp_sum;

    // --- 4. GENERATE THE NULLIFIER FOR DOUBLE-VOTING PREVENTION ---
    // The nullifier is a unique hash generated from the `user_secret` and the `election_id`.
    // The contract will store this public value and reject any transaction with a previously used nullifier.
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== user_secret;
    nullifierHasher.inputs[1] <== election_id;
    nullifier_hash <== nullifierHasher.out;
}

/*
=====================================
 Template: Main
=====================================
* @purpose: The top-level component for the entire circuit. It defines the final public inputs
           and outputs for the ZK-SNARK proof and connects the `VoteProof` sub-circuit.
*/
template Main(depth, numOptions) {
    // === PUBLIC INPUTS (used by the on-chain verifier contract) ===
    signal input root_in;                   // Public: The Merkle root to verify against.

    // === PRIVATE INPUTS (known only to the prover) ===
    signal input user_secret;
    signal input vote[numOptions];
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input election_id;

    // === PUBLIC OUTPUTS (values revealed with the proof, verified by the contract) ===
    signal output root_out;                  // Public: The same Merkle root, passed through as a public output.
    signal output vote_index;                // Public: The index for the chosen candidate.
    signal output nullifier_hash;            // Public: The unique nullifier to prevent double-voting.

    // Instantiate the main `VoteProof` circuit.
    component voteProof = VoteProof(depth, numOptions);

    // Connect all inputs from the Main template to the `voteProof` sub-component.
    voteProof.root <== root_in;
    voteProof.user_secret <== user_secret;
    voteProof.election_id <== election_id;
    for (var i = 0; i < depth; i++) {
        voteProof.pathElements[i] <== pathElements[i];
        voteProof.pathIndices[i] <== pathIndices[i];
    }
    for (var i = 0; i < numOptions; i++) {
        voteProof.vote[i] <== vote[i];
    }

    // Connect the outputs from `voteProof` to the final outputs of the Main template.
    root_out <== root_in;
    vote_index <== voteProof.vote_index;
    nullifier_hash <== voteProof.nullifier_hash;
}

// === CIRCUIT INSTANTIATION ===
// Creates an instance of the Main circuit with specific parameters.
// To change the system's configuration, you would modify these values and re-run the entire ZKP setup.
component main = Main(3, 3);