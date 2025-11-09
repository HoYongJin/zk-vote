// /**
//  * @file frontend/src/pages/Admin/AdminDashboardPage.js
//  * @desc The main navigation hub (dashboard) for authenticated administrators.
//  * Provides top-level links to different admin functionalities.
//  */

// import React from 'react';
// import { Link } from 'react-router-dom';

// // --- Style Definitions (CSS-in-JS Objects) ---
// // For better maintainability and UX (like :hover effects),
// // consider using CSS Modules or a library like styled-components.
// // These styles provide a cleaner, more structured dashboard look.

// const dashboardStyle = {
//   fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
//   padding: '30px',
//   maxWidth: '700px',
//   margin: '40px auto',
//   border: '1px solid #e0e0e0',
//   borderRadius: '12px',
//   boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
//   backgroundColor: '#ffffff',
// };

// const headerStyle = {
//   fontSize: '2em',
//   fontWeight: '600',
//   color: '#333',
//   borderBottom: '2px solid #f0f0f0',
//   paddingBottom: '15px',
//   marginBottom: '25px',
// };

// const navStyle = {
//   display: 'flex',
//   flexDirection: 'column',
//   gap: '15px', // Adds spacing between links
// };

// /**
//  * Base style for navigation links, designed to look more interactive.
//  * A real implementation should use CSS classes or styled-components for hover effects.
//  */
// const linkStyle = {
//   display: 'block',
//   padding: '16px 20px',
//   fontSize: '1.1em',
//   fontWeight: '500',
//   color: '#007bff', 
//   backgroundColor: '#f8f9fa',
//   borderRadius: '8px',
//   textDecoration: 'none',
//   transition: 'transform 0.2s ease, background-color 0.2s ease',
// };

// const mainLinkStyle = {
//   ...linkStyle,
//   color: '#ffffff',
//   backgroundColor: '#007bff', // Primary link
//   // &:hover { backgroundColor: '#0056b3' }
// };

// const secondaryLinkStyle = {
//   ...linkStyle,
//   color: '#495057',
//   backgroundColor: 'transparent',
//   border: '1px solid #ced4da',
//   // &:hover { backgroundColor: '#f1f3f5' }
// };


// /**
//  * Renders the Admin Dashboard page.
//  * This component serves as the main entry point for all administrative tasks,
//  * providing navigation to create new elections or manage existing ones.
//  *
//  * @returns {React.ReactElement} The rendered AdminDashboardPage component.
//  */
// function AdminDashboardPage() {
//   return (
//     // Use <main> for the primary content area for better accessibility
//     <main style={dashboardStyle}>
//       <header style={headerStyle}>
//         <h1>Admin Dashboard</h1>
//       </header>

//       {/* Navigation links for admin actions */}
//       <nav style={navStyle}>
        
//         {/* Link to create a new election */}
//         <Link 
//           to="/admin/create" 
//           style={mainLinkStyle}
//           aria-label="Create a new election"
//         >
//           Create New Election
//         </Link>
        
//         {/* Link to manage existing elections (register voters, finalize) */}
//         <Link 
//           to="/admin/manage" 
//           style={linkStyle}
//           aria-label="Manage existing elections"
//         >
//           Manage Existing Elections
//         </Link>
        
//         {/* Link to go back to the public-facing main page */}
//         <Link 
//           to="/" 
//           style={secondaryLinkStyle}
//           aria-label="Return to voter main page"
//         >
//           Return to Main (Voter) Page
//         </Link>

//       </nav>
//     </main>
//   );
// }

// export default AdminDashboardPage;