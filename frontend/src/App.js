// /**
//  * @file frontend/src/App.js
//  * @desc The main entry point for the React application.
//  * This file sets up the main router (`BrowserRouter`), global authentication
//  * logic (`AuthHandler`), and defines all page routes and their protection levels
//  * (e.g., `ProtectedRoute`, `AdminRoute`).
//  */

// import React, { useEffect } from 'react';
// import { BrowserRouter, Routes, Route, useNavigate, Navigate } from 'react-router-dom';
// import { useDispatch } from 'react-redux';
// import { setUser, setAdmin, clearUser, setRedirectComplete } from './store/authSlice'; // Import setLoading
// import { supabase } from './supabase';
// import { store } from './store/store'; // Used for state access outside React components

// // --- Page and Component Imports ---
// import LoginPage from './pages/LoginPage';
// import VoterMainPage from './pages/Voter/VoterMainPage';
// import VotePage from './pages/Voter/VotePage';
// import AdminMainPage from './pages/Admin/AdminMainPage'; // This is the main admin management page
// import CreateVotePage from './pages/Admin/CreateVotePage';
// import ProtectedRoute from './components/ProtectedRoute'; // Protects routes for all logged-in users
// import AdminRoute from './components/AdminRoute';       // Protects routes for admin users only

// // --- [CRITICAL FIX] AuthHandler Component ---
// // Moved *outside* the App component function.
// // Defining a component inside another component causes React to unmount and
// // remount it on *every* parent render, leading to massive state loss,
// // performance issues, and memory leaks (e.g., duplicate auth listeners).

// /**
//  * @component AuthHandler
//  * @desc A wrapper component that handles global authentication logic.
//  * It listens for Supabase auth state changes (login, logout) and checks
//  * the initial session on app load (refresh). It updates the Redux store
//  * with the user's auth and admin status.
//  * @param {object} props
//  * @param {React.ReactNode} props.children - The rest of the application to render.
//  */
// function AuthHandler({ children }) {
//     const dispatch = useDispatch();
//     const navigate = useNavigate();

//     useEffect(() => {
//         /**
//          * Checks if a user is an admin and handles the initial login redirect.
//          * @param {object} user - The Supabase user object.
//          */
//         const checkAdminAndRedirect = async (user) => {
//         try {
//             // Check if the user's ID exists in the 'Admins' table
//             const { data, error } = await supabase
//             .from('Admins')
//             .select('id')
//             .eq('id', user.id);
//             // Note: Do NOT use .single() here, as it throws an error if no row is found.
//             // We just want to check if data.length > 0.
        
//             if (error) {
//                 console.error("Error checking admin status:", error.message);
//                 throw error;
//             }

//             const isAdminUser = data && data.length > 0;
//             // Dispatch admin status to Redux store
//             dispatch(setAdmin(isAdminUser));

//             // --- Post-login redirect logic ---
//             // Check Redux store *directly* (via imported store) to see if we've already redirected.
//             // This is a valid pattern *inside* a static listener callback.
//             const { postLoginRedirectComplete } = store.getState().auth;

//             if (!postLoginRedirectComplete) {
//                 // If this is the first SIGNED_IN event, redirect based on role.
//                 if (isAdminUser) {
//                     console.log("AuthHandler: Admin signed in, redirecting to /admin");
//                     navigate('/admin');
//                 } else {
//                     console.log("AuthHandler: User signed in, redirecting to /");
//                     navigate('/');
//                 }
//                 // Mark redirect as complete in Redux to prevent re-redirects on token refresh
//                 dispatch(setRedirectComplete(true));
//             }
//             } catch (err) {
//                 console.error("Error in checkAdminAndRedirect:", err.message);
//                 // If admin check fails, still log them in as a regular user
//                 dispatch(setAdmin(false));
//                 if (!store.getState().auth.postLoginRedirectComplete) {
//                     navigate('/');
//                     dispatch(setRedirectComplete(true));
//                 }
//             }
//         };

//         // Set up the listener for Supabase auth state changes (e.g., login, logout)
//         const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
//             console.log(`Auth event: ${event}`, session);
//             if (event === 'SIGNED_IN') {
//                 if (session) {
//                     // Update Redux state with user info
//                     dispatch(setUser({ user: session.user, session }));
//                     // Check admin status and perform redirect
//                     checkAdminAndRedirect(session.user);
//                 }
//             } else if (event === 'SIGNED_OUT') {
//                 // Clear Redux state
//                 dispatch(clearUser());
//                 // Redirect to login page
//                 navigate('/login');
//             }
//             // Other events (TOKEN_REFRESHED, etc.) will update the session
//             // but typically don't require redirects, so we just update the user data.
//             if (session && (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED')) {
//                 dispatch(setUser({ user: session.user, session }));
//             }
//         });

//     /**
//      * Checks for an existing session when the app first loads (e.g., on page refresh).
//      * This keeps the user logged in.
//      */
//     const checkInitialSession = async () => {
//         // [UX] Set loading to true while we check.
//         // Note: Initial state in authSlice is already loading: true,
//         // but we ensure it here if this function were called at other times.
//         // dispatch(setLoading(true)); // Already true on init
      
//         try {
//             // Get the current session from Supabase
//             const { data: { session }, error: sessionError } = await supabase.auth.getSession();
//             if (sessionError) throw sessionError;

//             if (session) {
//                 // --- User IS logged in ---
//                 console.log("AuthHandler: Session found on initial load.");
//                 // Update Redux state
//                 dispatch(setUser({ user: session.user, session }));
                
//                 // Check if they are an admin
//                 const { data, error: adminError } = await supabase.from('Admins').select('id').eq('id', session.user.id);
//                 if (adminError) throw adminError;
                
//                 dispatch(setAdmin(data && data.length > 0));

//             } else {
//                 // --- User is NOT logged in ---
//                 console.log("AuthHandler: No session found on initial load.");
//                 dispatch(clearUser());
//             }
//         } catch (err) {
//              console.error("AuthHandler: Error during initial session check:", err.message);
//              dispatch(clearUser()); // Clear state on error
//         }
//         // `setUser` or `clearUser` (in authSlice) will set loading: false,
//         // which unblocks the Protected/Admin routes.
//     };
    
//     // Run the initial session check *once* when the component mounts
//     checkInitialSession();

//     // Cleanup: Unsubscribe from the auth listener when the component unmounts
//     return () => {
//       console.log("AuthHandler: Unsubscribing from auth listener.");
//       authListener.subscription.unsubscribe();
//     };
//   }, [dispatch, navigate]); // Dependencies for the useEffect hook

//   return children; // Render the rest of the application
// }

// /**
//  * @component App
//  * @desc The root React component. Sets up BrowserRouter and wraps the
//  * entire application in the AuthHandler to manage global auth state.
//  */
// function App() {
//     return (
//       <BrowserRouter>
//         {/* AuthHandler provides global auth context/state management */}
//         <AuthHandler>
//           {/* Routes define the page structure */}
//           <Routes>
//             {/* Public route: /login */}
//             <Route path="/login" element={<LoginPage />} />
  
//             {/* --- Protected Routes (Voter) --- */}
            
//             {/* Voter main dashboard (default page) */}
//             <Route 
//               path="/" 
//               element={
//                 <ProtectedRoute>
//                   <VoterMainPage />
//                 </ProtectedRoute>
//               } 
//             /> 
  
//             {/* Individual voting page */}
//             <Route 
//               path="/vote/:id" 
//               element={
//                 <ProtectedRoute>
//                   <VotePage />
//                 </ProtectedRoute>
//               } 
//             />
  
//             {/* --- Protected Routes (Admin) --- */}
            
//             {/* * Admin main management page
//              * This route uses AdminMainPage, which contains all logic
//              * for listing and managing votes (register, finalize, deploy, complete).
//              * The /admin/manage path is consolidated into /admin.
//             */}
//             <Route 
//               path="/admin" 
//               element={
//                 <AdminRoute>
//                   <AdminMainPage />
//                 </AdminRoute>
//               } 
//             />
  
//             {/* Admin page for creating a new vote */}
//             <Route 
//               path="/admin/create" 
//               element={
//                 <AdminRoute>
//                   <CreateVotePage />
//                 </AdminRoute>
//               } 
//             />
            
//             {/* [Suggestion] Add a catch-all redirect for non-admin users
//                 who might land on a non-existent route, e.g. /admin/dashboard */}
//             <Route 
//               path="/admin/*" 
//               element={
//                 <AdminRoute>
//                   {/* Redirects any other /admin/.. path to the main /admin page */}
//                   <Navigate to="/admin" replace />
//                 </AdminRoute>
//               } 
//             />
            
//             {/* [Suggestion] A catch-all for any other route not defined */}
//             <Route path="*" element={<Navigate to="/" replace />} />

//           </Routes>
//         </AuthHandler>
//       </BrowserRouter>
//     );
//   }

// export default App;




// frontend/src/App.js
import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setUser, setAdmin, clearUser, setRedirectComplete } from './store/authSlice';
import { supabase } from './supabase';
import { store } from './store/store';

// Page and Component Imports
import LoginPage from './pages/LoginPage';
import VoterMainPage from './pages/Voter/VoterMainPage';
import VotePage from './pages/Voter/VotePage';
import AdminMainPage from './pages/Admin/AdminMainPage';
import CreateVotePage from './pages/Admin/CreateVotePage';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';

// --- 인증 및 리디렉션 로직을 처리할 핸들러 컴포넌트 ---
function AuthHandler({ children }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    // 관리자인지 확인하고, 로그인 직후라면 적절한 페이지로 리디렉션하는 함수
    const checkAdminAndRedirect = async (user) => {
      const { data } = await supabase
        .from('Admins')
        .select('id')
        .eq('id', user.id);

      const isAdminUser = data && data.length > 0;
      dispatch(setAdmin(isAdminUser));

      const { postLoginRedirectComplete } = store.getState().auth;
      if (!postLoginRedirectComplete) {
        if (isAdminUser) {
          navigate('/admin');
        } else {
          navigate('/');
        }
        dispatch(setRedirectComplete(true));
      }
    };

    // Supabase 인증 상태 변경 리스너
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_IN') {
          if (session) {
            dispatch(setUser({ user: session.user, session }));
            checkAdminAndRedirect(session.user);
          }
        } else if (event === 'SIGNED_OUT') {
          dispatch(clearUser());
          navigate('/login');
        }
      }
    );

    // 페이지 첫 로드 시 현재 세션 확인 (새로고침 시 로그인 유지)
    const checkInitialSession = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            dispatch(setUser({ user: session.user, session }));
            
            // 👇 여기가 수정된 부분입니다! .single()을 제거했습니다. 👇
            const { data } = await supabase.from('Admins').select('id').eq('id', session.user.id);
            // 배열의 길이가 0보다 큰지를 확인하여 관리자 여부를 판단합니다.
            dispatch(setAdmin(data && data.length > 0));

        } else {
            dispatch(clearUser());
        }
    };
    checkInitialSession();

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [dispatch, navigate]);

  return children;
}

// --- 메인 App 컴포넌트 ---
function App() {
    return (
      <BrowserRouter>
        <AuthHandler>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
  
            {/* 유권자용 메인 페이지 */}
            <Route path="/" element={<ProtectedRoute><VoterMainPage /></ProtectedRoute>} /> 
  
            {/* 개별 투표 페이지 (공통) */}
            <Route path="/vote/:id" element={<ProtectedRoute><VotePage /></ProtectedRoute>} />
  
            {/* 관리자용 메인 페이지 (대시보드) */}
            <Route path="/admin" element={<AdminRoute><AdminMainPage /></AdminRoute>} />
  
            {/* 투표 생성 페이지 (별도) */}
            <Route path="/admin/create" element={<AdminRoute><CreateVotePage /></AdminRoute>} />
            
          </Routes>
        </AuthHandler>
      </BrowserRouter>
    );
  }

export default App;