import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_DIAL,
  PHONE_COUNTRIES,
  formatNational,
  hasForbiddenUsiCharacter,
  normalizePhoneInput,
  normalizeUsi,
  parseStoredPhone,
  validatePhone,
  validateStoredPhone,
  validateUsi,
} from "../../../supabase/functions/_shared/validation/identifiers";
import { baseFieldClass } from "./applicationFieldHelpers";

const OLDEST_YEAR = 1960;
const lockedClass = " bg-background-100 text-foreground-600";

/** Current year down to 1960, newest first, plus a saved value that falls outside that list (or is not a year). */
export function YearSelect({ id, name, value, locked, required }: { id: string; name: string; value?: string; locked?: boolean; required?: boolean }) {
  const years = useMemo(() => {
    const latest = new Date().getFullYear();
    return Array.from({ length: latest - OLDEST_YEAR + 1 }, (_, index) => String(latest - index));
  }, []);
  const saved = (value ?? "").trim();
  return (
    <select id={id} name={name} required={required && !locked} disabled={locked} defaultValue={saved} className={`${baseFieldClass}${locked ? lockedClass : ""}`}>
      <option value="">Select year</option>
      {saved && !years.includes(saved) ? <option value={saved}>{saved}</option> : null}
      {years.map((year) => (
        <option key={year} value={year}>{year}</option>
      ))}
    </select>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return message ? (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1 text-xs text-red-700">
      <i className="ri-error-warning-line mt-px" aria-hidden="true" />
      {message}
    </p>
  ) : null;
}

/**
 * USI: uppercases as you type, drops spaces and dashes, caps at 10 characters. The inline error never blocks saving a draft;
 * it is also set as the control's custom validity, which is what stops final submission.
 */
export function UsiInput({ id, name, value, locked, required, placeholder }: { id: string; name: string; value?: string; locked?: boolean; required?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState(() => validateUsi(value ?? ""));
  const [current, setCurrent] = useState(value ?? "");
  const [touched, setTouched] = useState(false);
  useEffect(() => ref.current?.setCustomValidity(message), [message]);
  // Wrong characters are reported straight away; "too short" waits until the field is left.
  const shown = touched || hasForbiddenUsiCharacter(current) ? message : "";
  return (
    <>
      <input
        ref={ref}
        id={id}
        name={name}
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        required={required && !locked}
        readOnly={locked}
        placeholder={placeholder}
        defaultValue={value}
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? `${id}-error` : undefined}
        onChange={(event) => {
          const next = normalizeUsi(event.target.value);
          if (next !== event.target.value) event.target.value = next;
          setCurrent(next);
          setMessage(validateUsi(next));
        }}
        onBlur={() => setTouched(true)}
        className={`${baseFieldClass} font-mono uppercase tracking-[0.2em]${locked ? lockedClass : ""}`}
      />
      <FieldError id={`${id}-error`} message={shown} />
    </>
  );
}

/**
 * Phone: country code dropdown plus a number input. The form reads the normalised E.164 value from a visually hidden
 * input carrying the field's name; the visible controls have no name. Saved values are shown, never rewritten, until edited.
 */
export function PhoneInput({ id, name, value, locked, required, placeholder }: { id: string; name: string; value?: string; locked?: boolean; required?: boolean; placeholder?: string }) {
  const storedRef = useRef<HTMLInputElement>(null);
  const ownChange = useRef(false);
  const initial = useMemo(() => parseStoredPhone(value ?? ""), [value]);
  const [dial, setDial] = useState(initial?.dial ?? DEFAULT_DIAL);
  const [text, setText] = useState(initial ? formatNational(initial.dial, initial.national) : (value ?? ""));
  const [message, setMessage] = useState(() => validateStoredPhone(value ?? ""));
  const [touched, setTouched] = useState(false);

  useEffect(() => storedRef.current?.setCustomValidity(message), [message]);

  // Follow values written into the hidden input from outside (restored drafts).
  useEffect(() => {
    const stored = storedRef.current;
    if (!stored) return;
    const follow = () => {
      if (ownChange.current) return;
      const parsed = parseStoredPhone(stored.value);
      if (parsed) { setDial(parsed.dial); setText(formatNational(parsed.dial, parsed.national)); }
      else setText(stored.value);
      setMessage(validateStoredPhone(stored.value));
    };
    stored.addEventListener("input", follow);
    return () => stored.removeEventListener("input", follow);
  }, []);

  const commit = (nextDial: string, typed: string) => {
    const normalized = normalizePhoneInput(nextDial, typed);
    setDial(normalized.dial);
    setText(normalized.national === typed.replace(/\D/g, "") ? typed : normalized.national);
    setMessage(validatePhone(normalized.dial, normalized.national));
    const stored = storedRef.current;
    if (!stored || stored.value === normalized.e164) return;
    // Native setter + input event, so the form's autosave and React's change tracking both see the edit.
    ownChange.current = true;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(stored, normalized.e164);
    stored.dispatchEvent(new Event("input", { bubbles: true }));
    ownChange.current = false;
  };

  const shown = touched ? message : "";
  return (
    <>
      <div className="flex gap-2">
        <select
          aria-label="Country code"
          value={dial}
          disabled={locked}
          onChange={(event) => commit(event.target.value, text)}
          className={`${baseFieldClass} w-auto max-w-[9.5rem] shrink-0${locked ? lockedClass : ""}`}
        >
          {PHONE_COUNTRIES.map((country) => (
            <option key={country.dial} value={country.dial}>{`${country.flag} +${country.dial} ${country.label}`}</option>
          ))}
          {PHONE_COUNTRIES.some((country) => country.dial === dial) ? null : <option value={dial}>{`+${dial}`}</option>}
        </select>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={text}
          readOnly={locked}
          placeholder={placeholder}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? `${id}-error` : undefined}
          onChange={(event) => commit(dial, event.target.value)}
          onBlur={() => {
            setTouched(true);
            const normalized = normalizePhoneInput(dial, text);
            if (!validatePhone(normalized.dial, normalized.national) && normalized.national) setText(formatNational(normalized.dial, normalized.national));
          }}
          className={`${baseFieldClass} min-w-0 flex-1${locked ? lockedClass : ""}`}
        />
        <input ref={storedRef} name={name} type="text" tabIndex={-1} aria-hidden="true" required={required && !locked} defaultValue={value} className="sr-only" />
      </div>
      <FieldError id={`${id}-error`} message={shown} />
    </>
  );
}
