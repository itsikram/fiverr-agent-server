import '../config/env.js';
import nodemailer from 'nodemailer';

/**
 * Email Service for sending password reset and other emails
 */
class EmailService {
  constructor() {
    this.isConfigured = this.hasRequiredConfig();

    if (this.isConfigured) {
      // Initialize transporter from environment variables
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
      });
    } else {
      this.transporter = null;
      console.warn('[Email] ⚠️  Email service not configured.');
      console.warn('[Email] To enable password reset emails, set these in your .env:');
      console.warn('[Email]   EMAIL_USER=your-email@gmail.com');
      console.warn('[Email]   EMAIL_PASSWORD=your-app-password');
      console.warn('[Email]   EMAIL_HOST=smtp.gmail.com');
      console.warn('[Email]   EMAIL_PORT=587');
    }
  }

  hasRequiredConfig() {
    const hasUser = !!process.env.EMAIL_USER;
    const hasPass = !!process.env.EMAIL_PASSWORD;
    
    if (!hasUser || !hasPass) {
      console.warn('[Email] Missing credentials:');
      console.warn('[Email]   EMAIL_USER:', hasUser ? '✓ set' : '✗ not set');
      console.warn('[Email]   EMAIL_PASSWORD:', hasPass ? '✓ set' : '✗ not set');
    }
    
    return hasUser && hasPass;
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email, resetToken, resetLink) {
    try {
      if (!this.isConfigured) {
        console.warn('[Email] Email service not configured. Skipping email send.');
        return { skipped: true, message: 'Email service not configured' };
      }

      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: email,
        subject: 'Password Reset Request',
        html: `
          <h2>Password Reset Request</h2>
          <p>You requested a password reset. Click the link below to reset your password:</p>
          <p><a href="${resetLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a></p>
          <p>Or copy this link: ${resetLink}</p>
          <p>This link will expire in 1 hour.</p>
          <p>If you did not request this, please ignore this email.</p>
          <hr>
          <p><small>If the button doesn't work, copy and paste this link in your browser: ${resetLink}</small></p>
          <p><small>Reset Token: ${resetToken}</small></p>
        `,
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('[Email] ✓ Password reset email sent to:', email);
      return result;
    } catch (error) {
      console.error('[Email] Failed to send password reset email:', error.message);
      throw error;
    }
  }

  /**
   * Verify email configuration
   */
  async verifyConnection() {
    if (!this.isConfigured) {
      console.warn('[Email] Email service not configured');
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('[Email] ✓ Email service configured and ready');
      return true;
    } catch (error) {
      console.error('[Email] ⚠️  Email service not properly configured:', error.message);
      return false;
    }
  }
}

export const emailService = new EmailService();
