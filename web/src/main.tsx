import { render } from 'preact';

import { App } from './app';

const root = document.getElementById('app');
if (!root) {
  throw new Error('index.html has no #app element');
}
render(<App />, root);
