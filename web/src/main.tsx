import { render } from 'preact';

import { App } from './app';
import { Router } from './routes/router';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('index.html has no #app element');
}
render(<App router={new Router(window)} />, root);
