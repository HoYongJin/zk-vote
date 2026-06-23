/**
 * @file frontend/src/components/Modal.tsx
 * @desc Reusable modal rendered in a portal. Closes on overlay click, the
 * explicit close button, or the Escape key.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const modalOverlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.7)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 1000,
};

const modalContentStyle: CSSProperties = {
  position: 'relative',
  backgroundColor: 'white',
  padding: '20px 30px',
  borderRadius: '8px',
  width: '500px',
  maxWidth: '90%',
  boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
};

const closeButtonStyle: CSSProperties = {
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

// The portal target must exist in index.html (<div id="modal-root"></div>).
const modalRoot = document.getElementById('modal-root');

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
}

const Modal = ({ isOpen, onClose, children }: ModalProps): ReactNode => {
  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !modalRoot) {
    return null;
  }

  return createPortal(
    <div style={modalOverlayStyle} onClick={onClose} role="dialog" aria-modal="true">
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close modal">
          &times;
        </button>
        {children}
      </div>
    </div>,
    modalRoot,
  );
};

export default Modal;
