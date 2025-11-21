const nodemailer = require("nodemailer");

// Create a test account or replace with real credentials.
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "salesorderweb@gmail.com",
    pass: "zagnxflbzubnrrbw",
  },
});

// Wrap in an async IIFE so we can use await.
async function sendMail(to, subject, text, html) {
  const info = await transporter.sendMail({
    from: '"Promark Tech Solutions" <salesorderweb@gmail.com>',
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendMail };
