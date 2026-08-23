# Email Configuration for Password Reset

The password reset feature requires email configuration. Follow these steps to set up email sending.

## Quick Start (Gmail)

### Step 1: Enable 2-Factor Authentication

1. Go to your Google Account: https://myaccount.google.com
2. Go to **Security** (left sidebar)
3. Enable **2-Step Verification** if not already enabled

### Step 2: Create App Password

1. Go to https://myaccount.google.com/apppasswords
2. Select **Mail** and **Windows Computer**
3. Google will generate a 16-character password
4. Copy this password (you'll need it in the next step)

### Step 3: Configure .env File

Add the following to your `.env` file in the `fiverr-server` directory:

```env
# Gmail SMTP Configuration
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_FROM=noreply@yourapp.com
FRONTEND_URL=http://localhost:3000
```

Replace:
- `your-email@gmail.com` with your Gmail address
- `xxxx xxxx xxxx xxxx` with the app password from Step 2 (remove spaces if needed)

### Step 4: Restart Server

```bash
npm run dev
```

You should see a message confirming email configuration:
```
[Email] ✓ Email service configured and ready
```

## Testing Email Configuration

### Test 1: Request a Password Reset

```bash
curl -X POST http://localhost:8765/auth/request-password-reset \
  -H "Content-Type: application/json" \
  -d '{"email":"your-email@gmail.com"}'
```

You should receive an email with the password reset token.

### Test 2: Check Logs

Look for these messages in the server logs:

**Success:**
```
[Email] ✓ Password reset email sent to: your-email@gmail.com
```

**Failure:**
```
[Email] Failed to send password reset email: [error message]
```

## Troubleshooting

### "Missing credentials for PLAIN"

**Cause:** EMAIL_USER or EMAIL_PASSWORD not set in .env

**Solution:**
1. Check that your .env file has EMAIL_USER and EMAIL_PASSWORD
2. Make sure you're using the app password (from apppasswords), not your regular Gmail password
3. Restart the server after updating .env

### "Invalid login" or "Authentication failed"

**Cause:** Wrong email or password

**Solution:**
1. Verify your Gmail address is correct
2. Generate a new app password from https://myaccount.google.com/apppasswords
3. Make sure you copied the full password (16 characters)
4. Remove any spaces from the password

### Email not received

**Cause:** Email might be in spam folder

**Solution:**
1. Check your spam/junk folder
2. Whitelist the sender email address
3. Check server logs for email sending errors

### How to Enable Less Secure Apps (Alternative)

If you don't want to use app passwords:

1. Go to https://myaccount.google.com/lesssecureapps
2. Turn on "Allow less secure apps"
3. Use your regular Gmail password (not app password)

> ⚠️ This is less secure. Using app passwords is recommended.

## Using Different Email Providers

### Outlook/Hotmail

```env
EMAIL_HOST=smtp-mail.outlook.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@outlook.com
EMAIL_PASSWORD=your-password
```

### Yahoo Mail

```env
EMAIL_HOST=smtp.mail.yahoo.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@yahoo.com
EMAIL_PASSWORD=your-app-password
```

### SendGrid

```env
EMAIL_HOST=smtp.sendgrid.net
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=apikey
EMAIL_PASSWORD=your-sendgrid-api-key
```

## Advanced Configuration

### SMTP Port Options

- **587** (TLS) - Start with unencrypted, then upgrade to TLS - Recommended
- **465** (SSL) - Direct SSL/TLS connection - Set `EMAIL_SECURE=true`
- **25** (Plain) - Unencrypted - Not recommended

### Custom Email Template

To customize the email template, edit `src/services/EmailService.js` in the `sendPasswordResetEmail()` method.

### Email Verification

To test if email configuration is correct, you can add this to your server code:

```javascript
import { emailService } from './services/EmailService.js';

// After server initialization
emailService.verifyConnection().then(isValid => {
  if (isValid) {
    console.log('Email service is properly configured');
  } else {
    console.log('Email service configuration failed');
  }
});
```

## What Happens Without Email Configuration

If you don't configure email:

1. ✓ Password reset endpoint still works
2. ✓ Reset token is still generated and saved
3. ✓ User can reset password manually using the token
4. ✗ Email with reset token is not sent

**To work around this:**
- In development, you can check the server logs for the reset token
- Or, manually provide the token to the user
- Or, access the database to get the token

## Testing Without Email

For development/testing without email setup:

1. User requests password reset
2. Check server logs for reset token
3. Manually provide the token to user: `passwordReset.token` from database
4. User uses the token in the reset password form

## Next Steps

1. ✓ Configure email credentials in `.env`
2. ✓ Restart the server
3. ✓ Test the password reset flow from the Expo app
4. ✓ Check email for reset link

For more details, see:
- `PASSWORD_RESET.md` - General password reset documentation
- `../fiverr-expo/PASSWORD_RESET.md` - Expo app password reset guide
