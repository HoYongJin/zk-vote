/**
 * @file frontend/src/components/Modal.js
 * @desc A reusable Modal component that renders its children in a portal.
 * Includes features like closing on overlay click, explicit close button,
 * and closing via the 'Escape' key for better UX and accessibility.
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom'; // Import createPortal

// --- [PERFORMANCE] Style Definitions ---
// Moved outside the component function to prevent re-creation on every render.
const modalOverlayStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.7)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 1000, // Ensure modal is on top
};

const modalContentStyle = {
  position: 'relative', // Needed for positioning the close button
  backgroundColor: 'white',
  padding: '20px 30px',
  borderRadius: '8px',
  width: '500px',
  maxWidth: '90%', // Ensure it's responsive on small screens
  boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
};

// [UX] Style for the new close button
const closeButtonStyle = {
  position: 'absolute',
  top: '10px',
  right: '15px',
  background: 'transparent',
  border: 'none',
  fontSize: '1.5rem',
  fontWeight: 'bold',
  color: '#888',
  cursor: 'pointer',
};

// Get the DOM node to which the portal will attach.
// This element must exist in `public/index.html` (e.g., <div id="modal-root"></div>)
const modalRoot = document.getElementById('modal-root');

/**
 * @component Modal
 * @desc Renders children in a modal dialog.
 *
 * @param {object} props
 * @param {boolean} props.isOpen - Controls whether the modal is visible.
 * @param {function} props.onClose - Callback function to call when the modal requests to be closed
 * (e.g., overlay click, Esc key, close button).
 * @param {React.ReactNode} props.children - The content to be rendered inside the modal.
 * @returns {React.ReactPortal | null} The rendered modal portal or null if not open.
 */
const Modal = ({ isOpen, onClose, children }) => {
  
  // [UX/Accessibility] Add 'Escape' key listener to close the modal
  useEffect(() => {
    /**
     * Handles the keydown event to check for 'Escape' key press.
     * @param {KeyboardEvent} event
     */
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose(); // Call the provided onClose function
      }
    };

    // Add listener only when the modal is open
    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    // Cleanup: Remove the listener when the modal closes or component unmounts
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]); // Re-run effect if isOpen or onClose changes

  // If the modal isn't open, render nothing.
  if (!isOpen) {
    return null;
  }

  // [Accessibility] Use createPortal to render the modal at the root of the DOM.
  // This avoids z-index issues and is better for screen readers.
  return createPortal(
    
    // 1. The Overlay: Clicking this closes the modal.
    <div style={modalOverlayStyle} onClick={onClose} role="dialog" aria-modal="true">
      
      {/* 2. The Content: Clicking this *stops* the click from bubbling up
             to the overlay, preventing the modal from closing. */}
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        
        {/* [UX] Explicit close button for better usability */}
        <button 
          style={closeButtonStyle} 
          onClick={onClose} 
          aria-label="Close modal"
        >
          &times; {/* This is the 'X' character */}
        </button>

        {/* 3. The Children: Renders whatever content was passed (e.g., the form) */}
        {children}

      </div>
    </div>,
    // Attach the portal to the 'modal-root' DOM element (must be in index.html)
    modalRoot 
  );
};

export default Modal;