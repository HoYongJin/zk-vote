// scripts/deployAll.js

const hre = require("hardhat");
const { ethers } = require("ethers");
const supabase = require("../server/supabaseClient"); // 서버의 Supabase 클라이언트를 가져옵니다.
require("dotenv").config();

async function main() {
    // 1. 터미널에서 배포할 선거의 UUID를 인자로 받습니다.
    // const electionUUID = process.argv[2];
    // if (!electionUUID) {
    //     console.error("오류: 배포할 선거의 UUID를 인자로 전달해야 합니다.");
    //     console.log("사용법: npx hardhat run scripts/deployAll.js <election-uuid> --network sepolia");
    //     process.exit(1);
    // }
    const electionUUID = process.env.ELECTION_UUID;
    if (!electionUUID) {
        console.error("오류: ELECTION_UUID 환경 변수를 설정해야 합니다.");
        console.log("사용법: ELECTION_UUID=<your-uuid> npx hardhat run scripts/deployAll.js --network sepolia");
        process.exit(1);
    }
    console.log(`선거 UUID [${electionUUID}]의 컨트랙트를 배포합니다.`);

    // 2. DB에서 해당 선거 정보를 조회합니다.
    const { data: election, error } = await supabase
        .from("Elections")
        .select("id, merkle_tree_depth")
        .eq("id", electionUUID)
        .single();

    if (error) {
        console.error("Supabase 쿼리 실패! 상세 오류:", error);
        return;
    }

    if(!election) {
        console.error("DB에서 해당 선거를 찾을 수 없습니다.");
        return;
    }

    // --- UUID를 uint256으로 변환 ---
    const hexUUID = "0x" + election.id.replace(/-/g, "");
    const electionId = BigInt(hexUUID);

    // 3. DB에서 가져온 merkle_tree_depth에 맞는 Verifier를 배포합니다.
    const verifierContractName = `Groth16Verifier_${election.merkle_tree_depth}`;
    const Verifier = await hre.ethers.getContractFactory(verifierContractName);
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log(`✅ ${verifierContractName} 배포 완료: ${verifierAddress}`);

    // 4. VotingTally 컨트랙트를 배포합니다.
    const VotingTally = await hre.ethers.getContractFactory("VotingTally");
    const votingTally = await VotingTally.deploy(verifierAddress, electionId);
    await votingTally.waitForDeployment();
    const votingTallyAddress = await votingTally.getAddress();
    console.log(`✅ VotingTally 배포 완료: ${votingTallyAddress}`);

    // 5. 배포된 컨트랙트 주소를 다시 DB에 업데이트합니다. (매우 중요)
    const { error: updateError } = await supabase
        .from("Elections")
        .update({ contract_address: votingTallyAddress })
        .eq("id", electionUUID);

    if (updateError) {
        console.error("DB에 컨트랙트 주소 업데이트 실패:", updateError);
    } else {
        console.log("✅ DB에 컨트랙트 주소가 성공적으로 업데이트되었습니다.");
    }

    console.log("\nEtherscan에 컨트랙트 인증을 시작합니다. (약 30초 소요)");
    
    // Etherscan이 트랜잭션을 인덱싱할 시간을 주기 위해 잠시 대기합니다.
    await new Promise(resolve => setTimeout(resolve, 30000)); 

    try {
        // Verifier 컨트랙트 인증
        await hre.run("verify:verify", {
            address: verifierAddress,
            constructorArguments: [], // 생성자 인자 없음
        });
        console.log(`✅ ${verifierContractName} 인증 성공!`);
    } catch (e) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log("ℹ️ Verifier 컨트랙트는 이미 인증되었습니다.");
        } else {
            console.error("Verifier 컨트랙트 인증 실패:", e);
        }
    }

    try {
        // VotingTally 컨트랙트 인증
        await hre.run("verify:verify", {
            address: votingTallyAddress,
            constructorArguments: [ // 생성자 인자를 배열로 전달
                verifierAddress,
                electionId.toString(),
            ],
        });
        console.log("✅ VotingTally 인증 성공!");
    } catch (e) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log("ℹ️ VotingTally 컨트랙트는 이미 인증되었습니다.");
        } else {
            console.error("VotingTally 컨트랙트 인증 실패:", e);
        }
    }
    
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});