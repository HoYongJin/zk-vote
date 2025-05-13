// import LoginButton from "./components/LoginButton";

// function App() {
//   return (
//     <div>
//       <h1>🗳️ 투표 시스템</h1>
//       <LoginButton />
//     </div>
//   );
// }

// export default App;

// App.js
import React, { useState } from "react";
import LoginButton from "./components/LoginButton";
import RegisterButton from "./components/RegisterButton";
import VoteButton from "./components/VoteButton";

function App() {
  const [jwt, setJwt] = useState(null);
  const [userSecret, setUserSecret] = useState(null);

  return (
    <div style={{ padding: 20 }}>
      <h1>🗳️ ZK 투표 시스템 테스트</h1>
      <LoginButton setJwt={setJwt} />
      <br /><br />
      <RegisterButton jwt={jwt} />
      <br /><br />
      <VoteButton jwt={jwt} setUserSecret={setUserSecret} />

      {userSecret && (
        <p>🔐 user_secret: <code>{userSecret}</code></p>
      )}
    </div>
  );
}

export default App;
