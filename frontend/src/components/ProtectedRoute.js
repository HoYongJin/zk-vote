/**
 * @file frontend/src/components/ProtectedRoute.js
 * @desc A route guard component for React Router.
 * It ensures that only *any* authenticated (logged-in) user can access
 * the child components wrapped by it. Non-admins are allowed.
 */

import React from 'react';
import { useSelector } from 'react-redux';
import { Navigate, useLocation } from 'react-router-dom'; // Import useLocation

// [UX Improvement] A simple, centered loading spinner component.
// This prevents layout shift while auth state is being confirmed.
// This can be shared with AdminRoute.js.
const CenteredLoadingSpinner = () => (
  <div style={{
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    fontSize: '1.2em',
    color: '#555'
  }}>
    {/* On-screen text remains in Korean as requested */}
    세션 정보를 확인 중입니다...
  </div>
);


/**
 * @component ProtectedRoute
 * @desc A private route component that restricts access to authenticated users only.
 *
 * It checks the authentication state from the Redux store:
 * 1. If `loading` (auth state initializing), it displays a loading indicator.
 * 2. If `isLoggedIn`, it renders the `children` (the protected page, e.g., VoterMainPage).
 * 3. If NOT `isLoggedIn`, it redirects the user to the login page ('/login').
 *
 * @param {object} props
 * @param {React.ReactNode} props.children - The child component(s) to render if authorized.
 * @returns {React.ReactElement | null} The child component, a redirect, or a loading indicator.
 */
const ProtectedRoute = ({ children }) => {
  // Select the authentication state from the Redux store.
  // `loading` is true until the initial session check (in AuthHandler) is complete.
  const { isLoggedIn, loading } = useSelector((state) => state.auth);

  // `useLocation` gets the current URL (e.g., "/vote/123") the user
  // was *trying* to access.
  const location = useLocation();

  // 1. [UX] While the auth state is being determined (loading: true),
  //    show a loader. This prevents a "flicker" where the user is
  //    briefly redirected to /login before the session is confirmed.
  if (loading) {
    return <CenteredLoadingSpinner />;
  }

  // 2. If auth check is complete and user is logged in, grant access.
  if (isLoggedIn) {
    return children; // Render the protected page (e.g., <VoterMainPage />)
  }

  // 3. If auth check is complete and user is NOT logged in, redirect to /login.
  // [UX Improvement]
  // `replace`: Modifies the browser history so the user doesn't get
  //            stuck in a redirect loop by clicking "back".
  // `state`: Passes the user's original intended location (`from: location`)
  //          to the LoginPage, which can use it to redirect back after login.
  return <Navigate to="/login" state={{ from: location }} replace />;
};

export default ProtectedRoute;