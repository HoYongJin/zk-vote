// import { useEffect } from "react";
// import supabase from "../supabase";

// export default function LoginButton() {
//   console.log("🟡 [1] 버튼 클릭됨 ✅");

//   const loginWithKakao = async () => {
//     const { error } = await supabase.auth.signInWithOAuth({
//       provider: "kakao",
//       options: {
//         redirectTo: process.env.REACT_APP_API_BASE_URL, // ✅ 리디렉션 주소 설정
//       },
//     });

//     console.log("🟡 [2] OAuth 함수 호출 완료");


//     if (error) {
//       console.error("❌ 로그인 실패:", error.message);
//     }
//   };

//   useEffect(() => {
//     const getToken = async () => {
//       console.log("🟡 [3] useEffect 실행됨 (리디렉션 후)");

//       const {
//         data: { session },
//       } = await supabase.auth.getSession();

//       console.log("🟡 [4] 세션:", session);

//       const jwt = session?.access_token;
//       if (!jwt) {
//         console.warn("⚠️ [4.5] JWT 없음 → 로그인 안 된 상태");
//         return;
//       }

//       console.log("🟢 [4.9] JWT 토큰:", jwt);

//     };

//     getToken();
//   }, []);

//   return <button onClick={loginWithKakao}>Kakao로 로그인</button>;
// }


import { useEffect } from "react";
import supabase from "../supabase";

export default function LoginButton({ setJwt }) {
  const loginWithKakao = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "kakao",
      options: {
        redirectTo: process.env.REACT_APP_REDIRECT_URL || window.location.origin,
      },
    });
  };

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        console.log("JWT 토큰:", session.access_token);
        setJwt(session.access_token);
      }
    })();
  }, [setJwt]);

  return <button onClick={loginWithKakao}> Kakao로 로그인</button>;
}
