const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { ethers } = require("ethers");
const supabase = require("../supabaseClient");

require("dotenv").config();

// ABI
const ABI_PATH = path.join(__dirname, "../../artifacts/contracts/VotingTally.sol/VotingTally.json");
const abi = JSON.parse(fs.readFileSync(ABI_PATH, "utf8")).abi;
const contractAddress = process.env.VOTINGTALLY_CONTRACT_ADDRESS;

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const votingTally = new ethers.Contract(contractAddress, abi, wallet);

router.post("/", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "NO TOKEN" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: "INVALID TOKEN" });
  }

  const email = user.email;

  const { data: voter } = await supabase
    .from("Voter")
    .select("user_secret")
    .eq("email", email)
    .maybeSingle();

  if (!voter || !voter.user_secret) {
    return res.status(403).json({ error: "NOT REGISTERED VOTER" });
  }

  console.log("인증성공");

  try {
    const inputData = req.body;

    // UUID 세션 생성
    const sessionId = uuidv4();
    const sessionDir = path.join(__dirname, `../zkp/tmp/${sessionId}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    console.log("UUID 생성 성공");

    // input.json 저장
    const inputPath = path.join(sessionDir, "input.json");
    fs.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));

    console.log("input.json 저장 성공");

    // prove.sh 실행
    await runCommand("bash", ["prove.sh", sessionId]);

    // 증명 파일 읽기
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "proof.json")));
    const publicSignals = JSON.parse(fs.readFileSync(path.join(sessionDir, "public.json")));

    //const a = proof.pi_a;
    const a = proof.pi_a.slice(0, 2);
    const b = proof.pi_b;
    const c = proof.pi_c;
    const merkleRoot = publicSignals[0];
    const voteIndex = publicSignals[1];
    const input = [merkleRoot.toString(), voteIndex.toString()];

    //const input = publicSignals.map(x => x.toString());

    // submitTally 호출
    const tx = await votingTally.submitTally(a, b, c, input);
    const receipt = await tx.wait();

    res.json({
      success: true,
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber
    });
  } catch (err) {
    console.error("❌ SUBMIT_ZK ERROR:", err);
    res.status(500).json({ error: "ZK_SUBMIT_FAIL", details: err.message });
  }
});

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: path.join(__dirname, "../zkp"),
      stdio: "inherit",
      env: { ...process.env, SESSION_ID: args[1] }, // uuid 전달
    });

    proc.on("close", (code) => {
      if (code !== 0) reject(new Error("prove.sh 실패"));
      else resolve();
    });
  });
}

module.exports = router;
