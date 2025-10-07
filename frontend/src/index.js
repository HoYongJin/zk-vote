// frontend/src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { store } from './store/store'; // 1. store를 불러옵니다.
import { Provider } from 'react-redux'; // 2. Provider를 불러옵니다.

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {/* 3. <App />을 <Provider>로 감싸고 store를 props로 전달합니다. */}
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
);