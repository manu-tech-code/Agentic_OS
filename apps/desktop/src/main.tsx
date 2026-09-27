import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Hud from './hud/Hud';
import { view } from './lib/shell';
import './styles.css';

// The Mac app's floating orb is its own small view; everything else is the full window.
if (view === 'hud') document.documentElement.classList.add('is-hud');

createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'hud' ? <Hud /> : <App />}</StrictMode>);
