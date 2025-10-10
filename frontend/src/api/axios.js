// frontend/src/api/axios.js
import axios from 'axios';
import { supabase } from '../supabase';

// 기본 URL 및 설정을 포함한 axios 인스턴스 생성
const instance = axios.create({
  // package.json의 proxy 설정 덕분에 '/api'만 적어도
  // 'http://여러분의_AWS_서버_주소:3001/api'로 요청됩니다.
  //baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// 요청을 보내기 전에 토큰을 헤더에 추가하는 인터셉터
instance.interceptors.request.use(async (config) => {
  // Supabase에서 현재 세션 정보를 가져옵니다.
  const { data } = await supabase.auth.getSession();
  const session = data.session;

  if (session) {
    // 세션이 있다면, Authorization 헤더에 JWT 토큰을 추가합니다.
    config.headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});


export default instance;