import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './app.css';

const ServerApp = React.lazy(() => import('./server/ServerApp'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{import.meta.env.VITE_DATA_MODE === 'server'
    ? <React.Suspense fallback={<div role="status" style={{ padding: 32 }}>계정을 확인하고 있습니다.</div>}><ServerApp /></React.Suspense>
    : <App />}</React.StrictMode>,
);
