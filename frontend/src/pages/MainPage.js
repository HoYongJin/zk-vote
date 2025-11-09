// // frontend/src/pages/MainPage.js

// import React, { useState, useEffect } from 'react';
// import { useSelector } from 'react-redux';
// import { Link } from 'react-router-dom';
// import { supabase } from '../supabase';
// // 'clearUser' and 'useDispatch' are removed as they are no longer used here.
// import axios from '../api/axios';
// import VoteCard from '../components/VoteCard'; // This path should now be correct.

// function MainPage() {
//   const auth = useSelector((state) => state.auth);
//   // 'dispatch' is removed.
  
//   const [votes, setVotes] = useState([]);
//   const [loading, setLoading] = useState(true);

//   const handleLogout = async () => {
//     await supabase.auth.signOut();
//   };

//   useEffect(() => {
//     const fetchVotes = async () => {
//       setLoading(true);
//       try {
//         const response = await axios.get('/registerableVote');
//         setVotes(response.data);
//       } catch (error) {
//         console.error('투표 목록을 불러오는 중 오류 발생:', error);
//         // It's good practice to clear the list on error.
//         setVotes([]); 
//       } finally {
//         setLoading(false);
//       }
//     };

//     if (auth.isLoggedIn) {
//       fetchVotes();
//     } else {
//       setLoading(false);
//       // Clear votes when the user logs out.
//       setVotes([]); 
//     }
//   }, [auth.isLoggedIn]);

//   return (
//     <div style={{ padding: '20px' }}>
//       {/* --- Header --- */}
//       <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
//         <h1>ZK-VOTE | 진행중인 투표</h1>
//         {auth.isLoggedIn ? (
//           <div>
//             <span>{auth.user.email}</span>

//             {auth.isAdmin && (
//               <Link to="/admin" style={{ marginLeft: '10px' }}>
//                 <button>관리자 페이지</button>
//               </Link>
//             )}

//             <button onClick={handleLogout} style={{ marginLeft: '10px' }}>로그아웃</button>
//           </div>
//         ) : (
//           <Link to="/login"><button>로그인</button></Link>
//         )}
//       </div>
//       <hr />

//       {/* --- Vote List --- */}
//       {auth.isLoggedIn && (
//         <div>
//           {loading ? (
//             <p>투표 목록을 불러오는 중...</p>
//           ) : votes.length > 0 ? (
//             votes.map((vote) => (
//               <VoteCard key={vote.id} vote={vote} />
//             ))
//           ) : (
//             <p>참여할 수 있는 투표가 없습니다.</p>
//           )}
//         </div>
//       )}
//     </div>
//   );
// }

// export default MainPage;