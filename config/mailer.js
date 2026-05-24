const nodemailer = require('nodemailer');

const getMailerConfig = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const from = process.env.MAIL_FROM || user;

  if (!host || !user || !pass || !from) {
    return null;
  }

  return { host, port, user, pass, secure, from };
};

const getTransporter = () => {
  const mailerConfig = getMailerConfig();
  if (!mailerConfig) return { transporter: null, mailerConfig: null };
  const transporter = nodemailer.createTransport({
    host: mailerConfig.host,
    port: mailerConfig.port,
    secure: mailerConfig.secure,
    auth: {
      user: mailerConfig.user,
      pass: mailerConfig.pass,
    },
  });
  return { transporter, mailerConfig };
};

const isMailerConfigured = () => !!getMailerConfig();

const sendResetCodeEmail = async ({ to, code }) => {
  const { transporter, mailerConfig } = getTransporter();
  if (!transporter || !mailerConfig) {
    console.warn('[MAIL] SMTP is not configured. Skipping reset password email send.');
    return false;
  }

  await transporter.sendMail({
    from: mailerConfig.from,
    to,
    subject: 'Gaming Body password reset code',
    text: `Your password reset code is ${code}. It expires in 15 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.4">
        <h2>Password Reset</h2>
        <p>Your password reset code is:</p>
        <p style="font-size:24px;font-weight:700;letter-spacing:2px">${code}</p>
        <p>This code expires in 15 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  return true;
};

const sendAdminAlertEmail = async ({ subject, text, html }) => {
  const { transporter, mailerConfig } = getTransporter();
  if (!transporter || !mailerConfig) {
    console.warn('[MAIL] SMTP is not configured. Skipping admin alert email send.');
    return false;
  }

  const adminRecipient = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  if (!adminRecipient) {
    console.warn('[MAIL] ADMIN_EMAIL/SMTP_USER is missing. Skipping admin alert email send.');
    return false;
  }

  await transporter.sendMail({
    from: mailerConfig.from,
    to: adminRecipient,
    subject,
    text,
    html,
  });

  return true;
};

module.exports = {
  sendResetCodeEmail,
  sendAdminAlertEmail,
  isMailerConfigured,
};
