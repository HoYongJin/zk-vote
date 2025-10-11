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
// const secretRouter = require("./routes/secret");


app.use("/setVote", setVoteRouter);
app.use("/registerableVote", registerableVoteRouter);
app.use('/finalizedVote', finalizedVoteRouter);
app.use("/register", registerRouter);
app.use("/registerByAdmin", registerByAdminRouter);
app.use("/finalizeVote", finalizeVoteRouter);
app.use("/proof", proofRouter);
app.use("/submitZk", submitZkRouter);
app.use("/addAdmins", addAdminsRouter);
// app.use("/secret", secretRouter);


app.listen(process.env.PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${process.env.PORT} & ${process.env.DEPLOY_URL}`);
});