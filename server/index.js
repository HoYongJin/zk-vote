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
const submitRouter = require("./routes/submit");

app.use("/proof", proofRouter);
app.use("/register", registerRouter);
app.use("/registerByAdmin", registerByAdminRouter);
app.use("/secret", secretRouter);
app.use("/submit", submitRouter);

app.listen(process.env.PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${process.env.PORT}`);
});