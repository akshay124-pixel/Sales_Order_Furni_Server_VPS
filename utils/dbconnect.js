const mongoose = require("mongoose");

const URI = process.env.DB_URL;
const dbconnect = async () => {
  try {
    await mongoose.connect(URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Database connected");
  } catch (error) {
    console.error("Error connecting to database:", error.message);
  }
};

module.exports = dbconnect;
