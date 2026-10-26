"use strict";

const nodemailer = require("nodemailer");

function createTransport(smtpConfig) {
  const options = {
    host: smtpConfig.host,
    port: Number(smtpConfig.port) || 587,
    secure: !!smtpConfig.secure,
    // A server that never answers fails after 30 seconds instead of hanging a send.
    connectionTimeout: 30000,
  };
  // Omitting `auth` entirely (rather than sending it with empty strings)
  // matters here: some relays -- e.g. an IP-allowlisted "unauthenticated"
  // relay a mail admin trusts by source IP instead of a login -- don't
  // expect an AUTH attempt at all and will reject one, even an empty one.
  // Leaving the SMTP username blank in Settings opts into that.
  if (smtpConfig.user) {
    options.auth = { user: smtpConfig.user, pass: smtpConfig.password };
  }
  return nodemailer.createTransport(options);
}

async function verifyConnection(smtpConfig) {
  const transport = createTransport(smtpConfig);
  await transport.verify();
  return true;
}

async function sendMail(smtpConfig, { to, subject, text, html, attachments }) {
  const transport = createTransport(smtpConfig);
  // nodemailer quotes the name itself, so a sender name with a quote or comma
  // in it still makes a valid From header (as in KeepTime).
  const address = smtpConfig.fromEmail || smtpConfig.user;
  const from = smtpConfig.fromName ? { name: smtpConfig.fromName, address } : address;
  return transport.sendMail({ from, to, subject, text, html, attachments });
}

module.exports = { createTransport, verifyConnection, sendMail };
