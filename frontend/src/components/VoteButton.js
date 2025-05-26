import axios from "axios";
import { useState } from "react";

export default function VoteButton({ jwt, setUserSecret }) {
  const [voteIndex, setVoteIndex] = useState("");

  const vote = async () => {
    if (!jwt) return alert("먼저 로그인하세요");
    const idx = parseInt(voteIndex);
    if (![0, 1, 2].includes(idx)) return alert("0, 1, 2 중 하나를 입력하세요");

    const sec = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/secret`,
      {},
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    const user_secret = sec.data.user_secret;
    setUserSecret(user_secret);

    const proof = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/proof`,
      { user_secret },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    const voteArray = [0, 0, 0];
    voteArray[idx] = 1;

    const input = {
      user_secret,
      vote: voteArray,
      pathElements: proof.data.path_elements,
      pathIndices: proof.data.path_index,
      root: proof.data.merkle_root,
    };

    const blob = new Blob(
      [JSON.stringify(input, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    //link.download = "input.json";
    //link.click();

    //alert("✅ input.json 다운로드 완료");
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
      <button onClick={vote}> 투표 입력 생성 (/secret → /proof)</button>
    </div>
  );
}