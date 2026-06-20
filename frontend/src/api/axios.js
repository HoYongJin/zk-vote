// frontend/src/api/axios.js
import axios from 'axios';
import { auth } from '../firebase';
import { getApiBaseUrl } from '../utils/apiBaseUrl';

// 기본 URL 및 설정을 포함한 axios 인스턴스 생성
const instance = axios.create({
    // 👇 baseURL에 백엔드 서버의 전체 주소를 직접 입력합니다.
    baseURL: getApiBaseUrl(),
    headers: {
      'Content-Type': 'application/json',
    },
  });

function removeHeader(headers, name) {
  if (!headers) return;
  if (typeof headers.delete === 'function') {
    headers.delete(name);
  }
  delete headers[name];
  delete headers[name.toLowerCase()];
}

function setHeader(headers, name, value) {
  if (typeof headers.set === 'function') {
    headers.set(name, value);
    return;
  }
  headers[name] = value;
}

// 요청을 보내기 전에 토큰을 헤더에 추가하는 인터셉터
instance.interceptors.request.use(async (config) => {
  if (config.skipAuth) {
    delete config.skipAuth;
    removeHeader(config.headers, 'Authorization');
    return config;
  }

  // Firebase(GCIP)에서 현재 사용자의 ID 토큰을 가져옵니다.
  // getIdToken()은 비동기다 (Supabase의 동기 access_token과 다름) — 이 인터셉터가
  // async이므로 await로 안전하게 처리한다. Firebase가 만료된 토큰은 자동 갱신한다.
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers = config.headers || {};
    setHeader(config.headers, 'Authorization', `Bearer ${token}`);
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});


export default instance;
