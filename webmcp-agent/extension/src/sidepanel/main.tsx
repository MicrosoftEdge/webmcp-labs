// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Side panel root is missing');
function SidePanel() {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const preference = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setDark(preference.matches);
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  return <FluentProvider className="app-provider" data-color-scheme={dark ? 'dark' : 'light'} theme={dark ? webDarkTheme : webLightTheme}>
    <App />
  </FluentProvider>;
}
createRoot(root).render(<SidePanel />);
