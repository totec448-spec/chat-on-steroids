import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { installIconSprite } from './icons.js';
import { startAppStore } from './state/app-store.js';
import './styles.css';

installIconSprite();
startAppStore();

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);

