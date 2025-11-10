// // frontend/src/components/VoteCard.js
// import React from 'react';
// import { Link } from 'react-router-dom';

// // CSS 스타일을 컴포넌트 파일 안에 간단하게 정의합니다.
// const cardStyle = {
//   border: '1px solid #ddd',
//   borderRadius: '8px',
//   padding: '16px',
//   margin: '16px 0',
//   boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
// };

// const titleStyle = {
//   margin: '0 0 8px 0',
// };

// const descriptionStyle = {
//   color: '#555',
//   marginBottom: '16px',
// };

// const linkStyle = {
//   textDecoration: 'none',
//   color: '#007bff',
//   fontWeight: 'bold',
// };

// const VoteCard = ({ vote }) => {
//   return (
//     <div style={cardStyle}>
//       <h3 style={titleStyle}>{vote.title}</h3>
//       <p style={descriptionStyle}>{vote.description}</p>
//       <Link to={`/vote/${vote.id}`} style={linkStyle}>
//         투표하러 가기 →
//       </Link>
//     </div>
//   );
// };

// export default VoteCard;