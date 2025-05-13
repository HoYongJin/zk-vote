// import React, { useState } from "react";
// import LoginButton from "./components/LoginButton";
// import RegisterButton from "./components/RegisterButton";
// import VoteButton from "./components/VoteButton";

// function App() {
//   const [jwt, setJwt] = useState(null);
//   const [userSecret, setUserSecret] = useState(null);

//   return (
//     <div style={{ padding: 20 }}>
//       <h1>🗳️ ZK 투표 시스템 테스트</h1>
//       <LoginButton setJwt={setJwt} />
//       <br /><br />
//       <RegisterButton jwt={jwt} />
//       <br /><br />
//       <VoteButton jwt={jwt} setUserSecret={setUserSecret} />

//       {userSecret && (
//         <p>🔐 user_secret: <code>{userSecret}</code></p>
//       )}
//     </div>
//   );
// }

// export default App;

import React, { useState, useEffect } from "react";
import supabase from "./supabase";
import LoginButton from "./components/LoginButton";
import RegisterButton from "./components/RegisterButton";
import VoteButton from "./components/VoteButton";

function App() {
  const [jwt, setJwt] = useState(null);
  const [userSecret, setUserSecret] = useState(null);

  // ✅ 로그인 상태 초기화 및 유지
  useEffect(() => {
    // 로그인 세션이 있으면 복구
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) {
        setJwt(session.access_token);
        console.log("🔄 초기 세션 복구:", session.access_token);
      }
    });

    // 로그인/로그아웃 실시간 반영
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        console.log("✅ 실시간 로그인 감지:", session.access_token);
        setJwt(session.access_token);
      } else {
        console.log("🚫 로그아웃됨");
        setJwt(null);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h1>🗳️ ZK 투표 시스템 테스트</h1>

      <LoginButton setJwt={setJwt} />

      <br /><br />

      {jwt ? (
        <>
          <RegisterButton jwt={jwt} />
          <br /><br />
          <VoteButton jwt={jwt} setUserSecret={setUserSecret} />
        </>
      ) : (
        <p>⚠️ 먼저 로그인해야 유권자 등록 및 투표를 할 수 있습니다.</p>
      )}

      {userSecret && (
        <p>🔐 user_secret: <code>{userSecret}</code></p>
      )}
    </div>
  );
}

export default App;
