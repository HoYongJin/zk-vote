// const { createClient } = require('@supabase/supabase-js');
// require("dotenv").config();

// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_KEY
// );


// module.exports = supabase;

const { createClient } = require('@supabase/supabase-js');
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;

// [수정된 부분]
// service_role_key가 .env 파일에 존재하면 그 키를 사용하고,
// 존재하지 않으면 기존의 SUPABASE_KEY (anon_key)를 사용합니다.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// 수정된 supabaseKey 변수를 createClient 함수의 두 번째 인자로 전달합니다.
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;