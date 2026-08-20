const nodemailer = require('nodemailer');

class EmailService {
  static transporter = null;

  static getTransporter() {
    if (!this.transporter) {
      // Для продакшена используйте реальные настройки SMTP
      // Для тестов можно использовать ethereal.email
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }
    return this.transporter;
  }

  static async sendVerificationEmail(email, name, code) {
    const transporter = this.getTransporter();
    const info = await transporter.sendMail({
      from: `"Ozon Manager" <${process.env.SMTP_FROM || 'noreply@example.com'}>`,
      to: email,
      subject: 'Подтверждение email',
      html: `
        <h1>Добро пожаловать, ${name}!</h1>
        <p>Для подтверждения вашего email введите код:</p>
        <h2 style="font-size: 32px; letter-spacing: 4px;">${code}</h2>
        <p>Код действителен 15 минут.</p>
        <p>Если вы не регистрировались, проигнорируйте это письмо.</p>
      `,
    });
    console.log(`[Email] Отправлено письмо на ${email}, messageId: ${info.messageId}`);
    // Для ethereal можно вывести URL предпросмотра
    if (process.env.NODE_ENV === 'development' && transporter.options.host === 'smtp.ethereal.email') {
      console.log(`[Email] Предпросмотр: ${nodemailer.getTestMessageUrl(info)}`);
    }
    return info;
  }
}

module.exports = EmailService;