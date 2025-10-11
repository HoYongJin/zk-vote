require("dotenv").config({ path: __dirname + '/.env' });
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const setVoteRouter = require("./routes/setVote");
const registerableVoteRouter = require("./routes/registerableVote");
const finalizedVoteRouter = require("./routes/finalizedVote");
const registerByAdminRouter = require("./routes/registerByAdmin");
const registerRouter = require("./routes/register");
const finalizeVoteRouter = require("./routes/finalizeVote");
const proofRouter = require("./routes/proof");
const submitZkRouter = require("./routes/submitZk");
const addAdminsRouter = require("./routes/addAdmins");


app.use("/api/management/addAdmins", addAdminsRouter);
app.use("/api/elections/set", setVoteRouter); // (관리자) 새 선거 생성: POST /api/elections
app.use("/api/elections/registerable", registerableVoteRouter); // 등록 가능한 선거 목록: GET /api/elections/registerable
app.use("/api/elections/finalized", finalizedVoteRouter); // 투표 가능한 선거 목록: GET /api/elections/finalized


app.use("/api/elections/:election_id/voters", registerByAdminRouter); // (관리자) 유권자 대량 등록: POST /api/elections/:id/voters
app.use("/api/elections/:election_id/register", registerRouter); // 유권자 등록: POST /api/elections/:id/register
app.use("/api/elections/:election_id/finalize", finalizeVoteRouter); // (관리자) 등록 마감: POST /api/elections/:id/finalize
app.use("/api/elections/:election_id/proof", proofRouter); // Merkle 증명 생성: POST /api/elections/:id/proof
app.use("/api/elections/:election_id/submit", submitZkRouter); // ZK 증명 제출: POST /api/elections/:id/submit





// app.use("/setVote", setVoteRouter);
// app.use("/registerableVote", registerableVoteRouter);
// app.use('/finalizedVote', finalizedVoteRouter);

// app.use("/register", registerRouter);
// app.use("/registerByAdmin", registerByAdminRouter);
// app.use("/finalizeVote", finalizeVoteRouter);
// app.use("/proof", proofRouter);
// app.use("/submitZk", submitZkRouter);
// app.use("/addAdmins", addAdminsRouter);



app.listen(process.env.PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${process.env.PORT} & ${process.env.DEPLOY_URL}`);
});