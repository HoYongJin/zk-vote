require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const proofRouter = require("./routes/proof");
const registerRouter = require("./routes/register");
const registerByAdminRouter = require("./routes/registerByAdmin");
const secretRouter = require("./routes/secret");
const submitZkRouter = require("./routes/submitZk");

app.use("/proof", proofRouter);
app.use("/register", registerRouter);
app.use("/registerByAdmin", registerByAdminRouter);
app.use("/secret", secretRouter);
app.use("/submitZk", submitZkRouter);

app.listen(process.env.PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${process.env.PORT} & ${process.env.DEPLOY_URL}`);
});