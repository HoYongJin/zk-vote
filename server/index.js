require("dotenv").config({ path: __dirname + '/.env' });
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
//app.use(cors());
app.use(express.json());
//app.use('/zkp-files', express.static(path.join(__dirname, 'zkp')));

const allowedOrigins = [
        'https://d33tqdup8vdi6i.cloudfront.net', // 1. 배포된 CloudFront 주소
        'http://localhost:3000'                  // 2. 로컬 개발 서버 주소
    ];
  
const corsOptions = {
    origin: function (origin, callback) {
        // 요청한 origin이 허용 목록에 있거나, (Postman 등에서) origin이 없는 경우
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true); // 허용
        } else {
            callback(new Error('Not allowed by CORS')); // 거부
        }
    },
    optionsSuccessStatus: 200
    };
app.use(cors(corsOptions));

const addAdminsRouter = require("./routes/addAdmins");
const setVoteRouter = require("./routes/setVote");
const setZkDeployRouther = require("./routes/setupAndDeploy");
const registerableVoteRouter = require("./routes/registerableVote");
const finalizedVoteRouter = require("./routes/finalizedVote");
const registerByAdminRouter = require("./routes/registerByAdmin");
const registerRouter = require("./routes/register");
const finalizeVoteRouter = require("./routes/finalizeVote");
const proofRouter = require("./routes/proof");
const submitZkRouter = require("./routes/submitZk");
const completeVoteRouter = require('./routes/completeVote');
const completedVoteRouter = require('./routes/completedVote');
const artifactInfoRouter = require('./routes/artifactInfo');
const meRouter = require('./routes/me');

// 증명 아티팩트 정적 제공 — build_<depth>_<candidates>/ 산출물만 노출한다.
// (audit Low: 전체 zkp/ 디렉토리를 노출하면 setUpZk.sh, .circom 소스,
// 기여 전 circuit_0000.zkey, ceremony.json 외 레거시 파일까지 새어 나간다.)
app.use('/api/zkp-files', (req, res, next) => {
    const allowed = /^\/build_\d+_\d+\/(VoteCheck_temp_js\/VoteCheck_temp\.wasm|circuit_final\.zkey|verification_key\.json)$/;
    if (!allowed.test(req.path)) {
        return res.status(404).json({ error: "NOT_FOUND", details: "Not a served proving artifact." });
    }
    return next();
}, express.static(path.join(__dirname, 'zkp')));
app.use('/api/me', meRouter); // 역할 조회 (AR-H4: 프론트 직접 테이블 읽기 대체)
app.use("/api/management/addAdmins", addAdminsRouter);
app.use("/api/elections/set", setVoteRouter); // (관리자) 새 선거 생성: POST /api/elections
app.use("/api/elections/registerable", registerableVoteRouter); // 등록 가능한 선거 목록: GET /api/elections/registerable
app.use("/api/elections/finalized", finalizedVoteRouter); // 투표 가능한 선거 목록: GET /api/elections/finalized
app.use('/api/elections/completed', completedVoteRouter);
app.use("/api/elections/:election_id/setZkDeploy", setZkDeployRouther);
app.use("/api/elections/:election_id/voters", registerByAdminRouter); // (관리자) 유권자 대량 등록: POST /api/elections/:id/voters
app.use("/api/elections/:election_id/register", registerRouter); // 유권자 등록: POST /api/elections/:id/register
app.use("/api/elections/:election_id/finalize", finalizeVoteRouter); // (관리자) 등록 마감: POST /api/elections/:id/finalize
app.use("/api/elections/:election_id/artifact-info", artifactInfoRouter); // 아티팩트 해시/경로 (AR-M6 클라이언트 검증)
app.use("/api/elections/:election_id/proof", proofRouter); // Merkle 증명 생성: POST /api/elections/:id/proof
app.use("/api/elections/:election_id/submit", submitZkRouter); // ZK 증명 제출: POST /api/elections/:id/submit
app.use('/api/elections/:election_id/complete', completeVoteRouter);

app.listen(process.env.PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${process.env.PORT} & ${process.env.DEPLOY_URL}`);
});