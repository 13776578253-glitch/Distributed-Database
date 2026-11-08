/** Accessible custom select that keeps menus inside the console design system. */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

export function Select<T extends string | number>({ label, value, options, onChange, disabled = false, className }: {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
  }, [open]); // 打开时定位当前选项，菜单打开期间不因外部轮询重置键盘位置。

  useEffect(() => {
    if (!open) return;
    optionRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function choose(option: SelectOption<T>) {
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(event.key === 'ArrowDown'
        ? Math.min(options.length - 1, index + 1) : Math.max(0, index - 1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  // 阻止 label 把菜单内点击再次转发给触发器，导致选完后菜单重新打开。
  return <div ref={root} className={`select${className ? ` ${className}` : ''}`}
    onClick={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="select-trigger" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-menu`}
      disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={onTriggerKeyDown}>
      <span className="select-value">{selected?.label ?? '—'}</span>
      <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div id={`${id}-menu`} className="select-menu" role="listbox" aria-label={label}>
      {options.map((option, index) => {
        const current = option.value === value;
        return <button key={String(option.value)} ref={node => { optionRefs.current[index] = node; }}
          type="button" role="option" aria-selected={current} tabIndex={-1}
          className="select-option" onClick={() => choose(option)}
          onKeyDown={event => onOptionKeyDown(event, index)}>
          <span className="select-option-label">{option.label}</span>
          {current && <span className="select-check" aria-hidden="true">✓</span>}
        </button>;
      })}
    </div>}
  </div>;
}
