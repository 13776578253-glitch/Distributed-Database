/** Local presentation settings shared by the console views. */
import { createContext, useContext, useEffect, useState } from 'react';

export const intervals = [1000, 3000, 5000, 10000, 0] as const;
export const themes = ['light', 'dark', 'system'] as const;
export const logLimits = [100, 200, 400] as const;

export interface Preferences {
  interval: typeof intervals[number];
  theme: typeof themes[number];
  hour12: boolean;
  logLimit: typeof logLimits[number];
}

const defaults: Preferences = { interval: 3000, theme: 'light', hour12: false, logLimit: 400 };
const key = 'minidb-console-preferences';
export const PreferencesContext = createContext(defaults);

function saved(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Preferences>;
    return {
      interval: value.interval !== undefined && intervals.includes(value.interval) ? value.interval : defaults.interval,
      theme: value.theme && themes.includes(value.theme) ? value.theme : defaults.theme,
      hour12: value.hour12 === true,
      logLimit: value.logLimit && logLimits.includes(value.logLimit) ? value.logLimit : defaults.logLimit,
    };
  } catch { return defaults; }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(saved);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { /* 页面内偏好仍然可用。 */ }
  }, [preferences]);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = preferences.theme === 'system'
        ? system.matches ? 'dark' : 'light' : preferences.theme;
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [preferences.theme]);
  return [preferences, setPreferences] as const;
}

const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
const clock24 = new Intl.DateTimeFormat('zh-CN', { ...timeOptions, hour12: false });
const clock12 = new Intl.DateTimeFormat('zh-CN', { ...timeOptions, hour12: true });

export function Clock({ at }: { at: string }) {
  const { hour12 } = useContext(PreferencesContext);
  return <time dateTime={at}>{(hour12 ? clock12 : clock24).format(new Date(at))}</time>;
}
