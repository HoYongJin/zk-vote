const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { ethers } = require("ethers");
const supabase = require("../supabaseClient");
require("dotenv").config();

// ABI 불러오기
const ABI_PATH = path.join(__dirname, "../../artifacts/contracts/VotingTally.sol/VotingTally.json");
const abi = JSON.parse(fs.readFileSync(ABI_PATH, "utf8")).abi;
const contractAddress = process.env.VOTINGTALLY_CONTRACT_ADDRESS;

// ethers provider 및 contract 객체 초기화
const provider = new ethers.providers.JsonRpcProvider(process.env.ZKEVM_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const votingTally = new ethers.Contract(contractAddress, abi, wallet);

// ZK 제출 엔드포인트
router.post("/", async (req, res) => {
    // Authorization 헤더에서 Bearer 토큰 추출
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // Token 유뮤 확인
    if(!token) {
        return res.status(400).json({ error: "NO TOKEN INFORMATION"});
    }

    // Supabase 토큰 인증 처리 후 유효하다면 user 정보를 얻음
    let user;
    try {
        const result = await supabase.auth.getUser(token);
        user = result.data.user;
        if (!user) throw new Error("USER NOT FOUND");
    } catch (authError) {
        return res.status(401).json({ error: "INVALID TOKEN", details: authError.message });
    }

    // user 정보 중 email 정보를 추출
    const email = user.email;

    // Voter 테이블에서 해당 이메일과 일치하는 유저를 찾음
    const { data: voter, error } = await supabase
        .from("Voter")
        .select("*")
        .eq("email", email)
        .maybeSingle();

    // 서버 에러 발생 시 로그 출력 및 응답 반환
    if (error) {
        console.error("DB ERROR: ", error.message);
        return res.status(500).json({ error: "DATABASE ERROR" });
    }

    // 등록된 유저가 아닌 경우 에러 발생
    if (!voter || !voter.user_secret) {
        return res.status(403).json({ error: "NOT REGISTERED USER" });
    }

    console.log("인증성공");

    try {
        const inputData = req.body;

        console.log("전달된 ZK Input 데이터 =======================");
        console.log("user_secret: ", inputData.user_secret);
        console.log("vote 배열: ", inputData.vote);
        console.log("pathElements: ", inputData.pathElements);
        console.log("pathIndices: ", inputData.pathIndices);
        console.log("Merkle Root(root_in): ", inputData.root_in);
        console.log("================================================");


        // UUID 세션 생성
        const sessionId = uuidv4();
        const sessionDir = path.join(__dirname, `../zkp/tmp/${sessionId}`);
        fs.mkdirSync(sessionDir, { recursive: true });

        console.log("UUID 생성 성공");

        // input.json 저장
        const inputPath = path.join(sessionDir, "input.json");
        fs.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));

        console.log("input.json 저장 성공");


        const savedInput = fs.readFileSync(inputPath, "utf8");
        console.log("실제 저장된 input.json 내용 =======================");
        console.log(savedInput);
        console.log("=====================================================");

        // prove.sh 실행
        await runCommand("bash", ["prove.sh", sessionId]);

        // 증명 파일 읽기
        const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "proof.json")));
        const publicSignals = JSON.parse(fs.readFileSync(path.join(sessionDir, "public.json")));

        // ZK 증명 구성 요소 분리
        const a = proof.pi_a.slice(0, 2);
        //const b = proof.pi_b.slice(0, 2);

        // const b = [
        //     proof.pi_b[0].slice(0, 2),
        //     proof.pi_b[1].slice(0, 2)
        //   ];
        const b = [
            [proof.pi_b[0][1], proof.pi_b[0][0]],  // 좌우 바뀜
            [proof.pi_b[1][1], proof.pi_b[1][0]],
          ];
          
        const c = proof.pi_c.slice(0, 2);

        const merkleRoot = publicSignals[0];
        const voteIndex = publicSignals[1];
        const input = [merkleRoot.toString(), voteIndex.toString()];

        console.log(a);
        console.log(b);
        console.log(c);
        console.log(merkleRoot);
        console.log(voteIndex);

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
        console.error("SUBMIT_ZK ERROR:", err);
        res.status(500).json({ error: "ZK_SUBMIT_FAIL", details: err.message });
  }
});

// shell 명령 실행 유틸 함수
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
            const proc = spawn(command, args, {
            cwd: path.join(__dirname, "../zkp"),
            stdio: "inherit",
            env: { ...process.env, SESSION_ID: args[1] }, // uuid 세션 전달
        });
  
        proc.on("close", (code) => {
            if (code !== 0) 
                reject(new Error("prove.sh failed"));
            else 
                resolve();
        });
    });
  }

module.exports = router;
