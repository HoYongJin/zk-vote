import axios from "axios";
import { useState } from "react";

export default function VoteButton({ jwt, setUserSecret }) {
  const [voteIndex, setVoteIndex] = useState("");

  const vote = async () => {
    if (!jwt) return alert("먼저 로그인하세요");
    const idx = parseInt(voteIndex);
    if (![0, 1, 2].includes(idx)) return alert("0, 1, 2 중 하나를 입력하세요");

    // 1. user_secret
    const sec = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/secret`,
      {},
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    const user_secret = sec.data.user_secret;
    setUserSecret(user_secret);

    // 2. Merkle proof
    const proof = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/proof`,
      { user_secret },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    // 3. vote 배열 생성
    const voteArray = [0, 0, 0];
    voteArray[idx] = 1;

    // 4. ZK input 생성
    const input = {
      user_secret,
      vote: voteArray,
      pathElements: proof.data.path_elements,
      pathIndices: proof.data.path_index,
      root: proof.data.merkle_root,
    };

    // 5. submitZk로 전달 (ZK 증명 + 블록체인 제출까지)
    const res = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/submitZk`,
      input,
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    alert(`✅ 투표 완료! TX Hash: ${res.data.txHash}`);
  };

  return (
    <div>
      <input
        type="number"
        placeholder="투표할 후보 번호 (0~2)"
        value={voteIndex}
        onChange={(e) => setVoteIndex(e.target.value)}
        min="0"
        max="2"
      />
      <button onClick={vote}>🗳️ 투표 제출</button>
    </div>
  );
}
