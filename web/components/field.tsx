import type { ReactNode, Ref } from "react";

interface FieldProps {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** Extra line beneath the input, for the reason a field behaves oddly. */
  hint?: ReactNode;
  /** Set when the environment pins this value; the field becomes read-only. */
  locked?: boolean;
}

/**
 * The one labelled text input of the product.
 *
 * Shared by the credential dialog and the storage settings because they grew
 * apart the moment each had its own copy: same shape, same focus ring, and the
 * "locked" state lives in one place instead of two.
 */
export function Field({
  id,
  label,
  type = "text",
  autoComplete,
  placeholder,
  value,
  onChange,
  inputRef,
  hint,
  locked = false,
}: FieldProps) {
  return (
    <label className="import-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        ref={inputRef}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        disabled={locked}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}
