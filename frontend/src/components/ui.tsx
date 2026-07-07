import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import type { ToastMessage } from './useToasts';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'warning' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: LucideIcon;
  isLoading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  icon: Icon,
  isLoading = false,
  fullWidth = false,
  children,
  disabled,
  className,
  ...props
}: ButtonProps) {
  const classes = ['ui-button', `ui-button--${variant}`, fullWidth ? 'ui-button--full' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || isLoading} {...props}>
      {isLoading ? <Loader2 className="ui-icon ui-icon--spin" aria-hidden="true" /> : Icon ? <Icon className="ui-icon" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: ButtonVariant;
  isLoading?: boolean;
}

export function IconButton({ icon: Icon, label, variant = 'ghost', isLoading = false, disabled, className, ...props }: IconButtonProps) {
  const classes = ['ui-icon-button', `ui-icon-button--${variant}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={classes} aria-label={label} title={label} disabled={disabled || isLoading} {...props}>
      {isLoading ? <Loader2 className="ui-icon ui-icon--spin" aria-hidden="true" /> : <Icon className="ui-icon" aria-hidden="true" />}
    </button>
  );
}

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="ui-help">{hint}</p>}
      {error && (
        <p className="ui-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="ui-input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="ui-textarea" {...props} />;
}

interface DialogProps {
  isOpen: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  tone?: 'default' | 'danger' | 'warning';
}

const modalRoot = () => document.getElementById('modal-root') ?? document.body;

export function Dialog({ isOpen, title, description, children, footer, onClose, tone = 'default' }: DialogProps) {
  if (!isOpen) return null;
  const root = modalRoot();

  return createPortal(
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`ui-dialog ui-dialog--${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="ui-dialog__header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="닫기" onClick={onClose} />
        </div>
        {children && <div className="ui-dialog__body">{children}</div>}
        {footer && <div className="ui-dialog__footer">{footer}</div>}
      </section>
    </div>,
    root,
  );
}

export function ToastViewport({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  return (
    <div className="ui-toast-region" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div key={toast.id} className={`ui-toast ui-toast--${toast.type}`}>
          <div className="ui-toast__icon">
            {toast.type === 'success' ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
          </div>
          <div>
            <strong>{toast.title}</strong>
            {toast.description && <p>{toast.description}</p>}
          </div>
          <IconButton icon={X} label="알림 닫기" onClick={() => onDismiss(toast.id)} />
        </div>
      ))}
    </div>
  );
}

interface PageShellProps {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'normal' | 'wide' | 'narrow';
}

export function PageShell({ title, eyebrow, actions, children, width = 'normal' }: PageShellProps) {
  return (
    <main className={`page-shell page-shell--${width}`}>
      <header className="page-shell__header">
        <div>
          {eyebrow && <p className="page-shell__eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
        </div>
        {actions && <div className="page-shell__actions">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

interface StatusBadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}

export function StatusBadge({ children, tone = 'neutral' }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

interface ElectionListProps<T> {
  title: string;
  description?: ReactNode;
  items: T[];
  empty: ReactNode;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}

export function ElectionList<T>({ title, description, items, empty, getKey, renderItem }: ElectionListProps<T>) {
  return (
    <section className="election-section">
      <div className="election-section__header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <StatusBadge>{items.length}</StatusBadge>
      </div>
      {items.length === 0 ? <div className="empty-state">{empty}</div> : <ul className="election-list">{items.map((item) => <li key={getKey(item)}>{renderItem(item)}</li>)}</ul>}
    </section>
  );
}

export function ProgressOverlay({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <div className="progress-overlay" role="status" aria-live="assertive">
      <div className="progress-overlay__panel">
        <Loader2 className="progress-overlay__icon" aria-hidden="true" />
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  );
}
