// Deploy-time guard (SECURITY_AUDIT SOL-VERIF-1).
//
// VotingTally.IVerifier is hard-typed to verifyProof(...,uint256[4]) and
// submitTally calls it with a uint256[4]. A verifier whose verifyProof takes
// uint[2]/uint[3] (a pre-C1 leftover that name-resolves to the same
// Groth16Verifier_<depth>_<candidates> pattern) hits a non-existent selector and
// reverts EVERY submitTally — configureElection still succeeds, so the election
// looks healthy until voting opens and then no vote can ever be cast.
//
// Refuse to deploy unless the resolved verifier's public-signal arity is exactly 4.

const REQUIRED_PUBLIC_SIGNALS = "uint256[4]";

function assertUint4Verifier(factory, contractName) {
  const verifyFns = factory.interface.fragments.filter(
    (f) => f.type === "function" && f.name === "verifyProof"
  );
  const ok = verifyFns.some(
    (f) => f.inputs.length === 4 && f.inputs[3].type === REQUIRED_PUBLIC_SIGNALS
  );
  if (!ok) {
    const got = verifyFns.length
      ? verifyFns
          .map((f) => `verifyProof(${f.inputs.map((i) => i.type).join(",")})`)
          .join(" | ")
      : "no verifyProof function";
    throw new Error(
      `Refusing to deploy ${contractName}: its verifyProof public-signal arity is not ` +
        `${REQUIRED_PUBLIC_SIGNALS} (found: ${got}). A uint[2]/uint[3] verifier wired into ` +
        `the uint256[4] VotingTally reverts every submitTally and permanently bricks the ` +
        `election (SECURITY_AUDIT SOL-VERIF-1). Regenerate the verifier with setUpZk.sh.`
    );
  }
}

module.exports = { assertUint4Verifier, REQUIRED_PUBLIC_SIGNALS };
