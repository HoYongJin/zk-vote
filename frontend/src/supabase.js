import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

// --- 디버깅을 위한 코드 ---
console.log('Supabase URL:', supabaseUrl);
// anoyKey는 민감하므로 존재 여부만 확인합니다.
console.log('Is Supabase Anon Key Loaded?:', supabaseAnonKey); 

export const supabase = createClient(supabaseUrl, supabaseAnonKey);