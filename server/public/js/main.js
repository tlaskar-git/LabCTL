import { render } from 'preact';
import { html } from './ui.js';
import { App } from './app.js';
import { applyTheme, getTheme } from './theme.js';

applyTheme(getTheme());
render(html`<${App}/>`, document.getElementById('root'));
