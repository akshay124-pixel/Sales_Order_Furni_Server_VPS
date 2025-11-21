require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const SignupRoute = require("./Router/SignupRoute");
const LoginRoute = require("./Router/LoginRoute");
const dbconnect = require("./utils/dbconnect");
const Routes = require("./Router/Routes");
const Controller = require("./Controller/Logic");

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO Check Kar Rha HuN
Controller.initSocket(server);

// CORS configuration
const corsOptions = {
  origin: process.env.APP_URL,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ["Content-Type", "Authorization"],
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));

// Routes
app.use("/api", Routes);
app.use("/auth", LoginRoute);
app.use("/user", SignupRoute);

// Start server after DB connection
const PORT = process.env.PORT || 6000;
dbconnect()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`App listening on port ${PORT}!`);
    });
  })
  .catch((error) => {
    console.error("Database connection failed", error);
    process.exit(1);
  });
