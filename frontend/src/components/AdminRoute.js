/**
 * @file frontend/src/components/AdminRoute.js
 * @desc A route guard component for React Router.
 * It ensures that only authenticated users with administrative privileges
 * can access the child components wrapped by it.
 */

import React from 'react';
import { useSelector } from 'react-redux';
import { Navigate, useLocation } from 'react-router-dom'; // Import useLocation

// [UX Improvement] A simple, centered loading spinner component.
// It's better to show a structured loading state than just text.
// You can replace this with your own styled spinner component.
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
    관리자 권한을 확인 중입니다...
  </div>
);

/**
 * @component AdminRoute
 * @desc A private route component that restricts access to administrators only.
 *
 * It checks the authentication state from the Redux store:
 * 1. If `loading` (auth state initializing), it displays a loading indicator.
 * 2. If `isLoggedIn` AND `isAdmin`, it renders the `children` (the protected page).
 * 3. If `isLoggedIn` but NOT `isAdmin`, it redirects to the voter main page ('/').
 * 4. If NOT `isLoggedIn`, it redirects to the login page ('/login').
 *
 * @param {object} props
 * @param {React.ReactNode} props.children - The child component(s) to render if authorized (e.g., <AdminMainPage />).
 * @returns {React.ReactElement | null} The child component, a redirect, or a loading indicator.
 */
const AdminRoute = ({ children }) => {
  // Select the authentication state from the Redux store.
  // `loading: true` persists until *both* user session AND admin status are checked
  // (as defined in authSlice.js), which prevents UI flicker.
  const { isLoggedIn, isAdmin, loading } = useSelector((state) => state.auth);
  
  // `useLocation` gets the current URL to pass to the login page for redirection after success.
  const location = useLocation();

  // 1. While auth state is being determined, show a full-page loader.
  // This is the correct behavior based on our authSlice logic.
  if (loading) {
    return <CenteredLoadingSpinner />;
  }

  // 2. If auth is checked and user is both logged in AND an admin, grant access.
  if (isLoggedIn && isAdmin) {
    return children; // Render the protected admin page (e.g., <AdminMainPage />)
  }

  // 3. [UX Improvement] If user is logged in but NOT an admin, redirect to voter main page.
  if (isLoggedIn && !isAdmin) {
    // `replace` prevents this redirect from being added to browser history.
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  // 4. If user is not logged in at all, redirect to the login page.
  // Pass the current `location` so the user can be redirected back
  // to this admin page after successfully logging in.
  return <Navigate to="/login" state={{ from: location }} replace />;
};

export default AdminRoute;