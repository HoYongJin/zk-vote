// // frontend/src/setupProxy.js
// const { createProxyMiddleware } = require('http-proxy-middleware');

// module.exports = function(app) {
//   app.use(
//     // 여기에 백엔드 API 경로들을 모두 나열합니다.
//     [
//       '/registerableVote',
//       '/finalizedVote',
//       '/registerByAdmin',
//       '/finalizeVote',
//       '/addAdmins',
//       '/setVote',
//     ],
//     createProxyMiddleware({
//       target: 'http://43.203.140.136:3001',
//       changeOrigin: true,
//     })
//   );
// };