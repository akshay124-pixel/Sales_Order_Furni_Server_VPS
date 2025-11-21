const { Signup } = require("../Controller/AuthLogic");

const express = require("express");
const router = express.Router();

router.route("/signup").post(Signup);

module.exports = router;
