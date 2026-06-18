// frontend/src/api/axios.js
import axios from 'axios';
import { supabase } from '../supabase';
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

  // Supabase에서 현재 세션 정보를 가져옵니다.
  const { data } = await supabase.auth.getSession();
  const session = data.session;

  if (session) {
    // 세션이 있다면, Authorization 헤더에 JWT 토큰을 추가합니다.
    config.headers = config.headers || {};
    setHeader(config.headers, 'Authorization', `Bearer ${session.access_token}`);
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});


export default instance;
