/** Three-mode theme selector rendered as tactile preview cards. */
import type { Preferences } from './preferences.tsx';

const options: readonly { value: Preferences['theme']; label: string; hint: string }[] = [
  { value: 'light', label: '浅色', hint: 'Rosé Pine Dawn' },
  { value: 'dark', label: '深色', hint: 'Rosé Pine' },
  { value: 'system', label: '跟随系统', hint: '自动切换' },
];

export function ThemePicker({ value, onChange }: {
  value: Preferences['theme'];
  onChange: (value: Preferences['theme']) => void;
}) {
  return <div className="theme-picker" role="group" aria-label="主题">
    {options.map(option => <button key={option.value} type="button" className="theme-option"
      aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
      <span className={`theme-swatch ${option.value}`} aria-hidden="true"><i /><i /><i /></span>
      <span className="theme-copy"><strong>{option.label}</strong><small>{option.hint}</small></span>
      {option.value === value && <svg className="theme-check" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>}
    </button>)}
  </div>;
}
