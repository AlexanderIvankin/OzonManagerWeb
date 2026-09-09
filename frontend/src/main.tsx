import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import { initTheme } from './lib/theme';
import './index.css';

// Страховка к inline-скрипту в index.html: синхронизирует тему,
// если её состояние менялось через toggleTheme в прошлом сеансе
initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
);