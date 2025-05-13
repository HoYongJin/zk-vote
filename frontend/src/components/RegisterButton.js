import axios from "axios";
import { useState } from "react";

export default function RegisterButton({ jwt }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");

  const register = async () => {
    if (!jwt) return alert("먼저 로그인하세요");
    if (!name || !id) return alert("이름과 학번을 입력하세요");

    const res = await axios.post(
      `${process.env.REACT_APP_API_BASE_URL}/register`,
      { name, id },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    alert("✅ 등록 완료: " + JSON.stringify(res.data));
  };

  return (
    <div>
      <input
        type="text"
        placeholder="이름"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        placeholder="학번"
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <button onClick={register}> 유권자 등록 (/register)</button>
    </div>
  );
}