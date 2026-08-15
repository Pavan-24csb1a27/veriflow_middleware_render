const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_EXPIRY = '7d';

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      // Deliberately vague — do not reveal whether an email is registered
      // to an unauthenticated caller, this prevents user enumeration.
      return res.status(409).json({ error: 'Could not create account with these details.' });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ email: email.toLowerCase(), passwordHash });

    const token = signToken(user._id.toString());
    res.status(201).json({ token, user: { id: user._id, email: user.email } });
  } catch (err) {
    console.error('[auth/register] error:', err.message);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    // Same generic error whether the email doesn't exist or the password
    // is wrong — again, avoid leaking which case it was.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user._id.toString());
    res.json({ token, user: { id: user._id, email: user.email } });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

module.exports = router;
