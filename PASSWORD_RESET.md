# Password Reset Feature

This document explains how to use the password reset feature in the Fiverr Agent Message Server.

## Setup

### 1. Email Configuration

Add the following environment variables to your `.env` file:

```env
# Gmail SMTP Configuration (using Gmail)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=noreply@yourapp.com

# Frontend URL (for reset link)
FRONTEND_URL=http://localhost:3000
```

### 2. Gmail App Password Setup

If using Gmail:
1. Enable 2-Factor Authentication on your Gmail account
2. Go to https://myaccount.google.com/apppasswords
3. Select "Mail" and "Windows Computer" (or your device)
4. Generate an app password
5. Use this password in `EMAIL_PASSWORD` environment variable

### 3. Install Nodemailer

```bash
npm install nodemailer
```

## API Endpoints

### Request Password Reset

**Endpoint:** `POST /auth/request-password-reset`

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "If an account exists with this email, a password reset link has been sent."
}
```

**Note:** The endpoint returns the same message whether the email exists or not (security best practice).

---

### Reset Password

**Endpoint:** `POST /auth/reset-password`

**Request Body:**
```json
{
  "email": "user@example.com",
  "token": "reset-token-from-email",
  "newPassword": "new-secure-password"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Password has been reset successfully."
}
```

**Error Response (401):**
```json
{
  "error": "Invalid or expired reset token"
}
```

---

## Frontend Integration

### Step 1: Request Password Reset

User enters their email on the "Forgot Password" page:

```javascript
const response = await fetch('/auth/request-password-reset', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: userEmail })
});
```

### Step 2: Click Email Link

User receives an email with a reset link:
```
http://localhost:3000/reset-password?token=abc123&email=user@example.com
```

### Step 3: Submit New Password

On the reset password page, capture the token and email from URL params, then submit:

```javascript
const resetPassword = async (token, email, newPassword) => {
  const response = await fetch('/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      email,
      newPassword
    })
  });

  if (response.ok) {
    // Redirect to login
    window.location.href = '/login';
  } else {
    // Show error message
    const error = await response.json();
    console.error(error.error);
  }
};
```

## Security Features

✓ Reset tokens expire after 1 hour
✓ Tokens are randomly generated (32 bytes)
✓ Password hashing uses PBKDF2 with 100,000 iterations
✓ Passwords hashed with unique per-user salts
✓ Email existence not revealed (returns same message for existing/non-existing emails)
✓ Tokens cleared after successful password reset

## Testing

### Manual Testing with cURL

```bash
# Step 1: Request password reset
curl -X POST http://localhost:8765/auth/request-password-reset \
  -H "Content-Type: application/json" \
  -d '{"email":"mdikram295@gmail.com"}'

# Step 2: Reset password (use token from email)
curl -X POST http://localhost:8765/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "email":"mdikram295@gmail.com",
    "token":"your-reset-token-here",
    "newPassword":"newsecurepassword"
  }'
```

## Troubleshooting

### Email not sending?

1. Check `.env` variables are set correctly
2. Check Gmail app password (not regular password)
3. Enable "Less secure app access" if using Gmail
4. Check server logs for email service errors
5. Test email service with: `npm run test:email`

### Reset token expired?

Tokens are valid for 1 hour. User needs to request a new one.

### Password requirements?

- Minimum 6 characters
- Any characters are allowed
- Consider enforcing stronger passwords in your frontend validation
