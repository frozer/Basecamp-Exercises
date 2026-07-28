const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const FASTAPI_BASE_URL = process.env.FASTAPI_URL || 'http://localhost:8000';

// Middleware
app.use(cors());
app.use(express.json());

// Mock user database
const users = new Map();

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', service: 'Node.js Backend' });
});

// Register/Login user
app.post('/api/auth/register', (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  users.set(email, {
    name,
    email,
    createdAt: new Date(),
  });

  res.json({
    success: true,
    message: 'User registered successfully',
    user: { name, email },
  });
});

// Get user info
app.get('/api/users/:email', (req, res) => {
  const { email } = req.params;
  const user = users.get(email);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

// Get email summary
app.post('/api/emails/summary', async (req, res) => {
  try {
    const { email, startDate, endDate } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Verify user exists
    if (!users.has(email)) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    // Call FastAPI backend
    const params = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const response = await axios.post(`${FASTAPI_BASE_URL}/emails/summarize`, null, {
      params,
    });

    res.json({
      email,
      summary: response.data,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Error fetching summary:', error.message);
    res.status(500).json({
      error: 'Failed to fetch email summary',
      details: error.message,
    });
  }
});

// Get email priorities
app.post('/api/emails/priorities', async (req, res) => {
  try {
    const { email, startDate, endDate } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Verify user exists
    if (!users.has(email)) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    // Call FastAPI backend
    const params = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const response = await axios.post(`${FASTAPI_BASE_URL}/emails/prioritize`, null, {
      params,
    });

    res.json({
      email,
      priorities: response.data,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Error fetching priorities:', error.message);
    res.status(500).json({
      error: 'Failed to fetch email priorities',
      details: error.message,
    });
  }
});

// Get email by date
app.get('/api/emails/by-date', async (req, res) => {
  try {
    const { email, date } = req.query;

    if (!email || !date) {
      return res.status(400).json({ error: 'Email and date are required' });
    }

    if (!users.has(email)) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    // For a specific date, set start and end to the same day
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const params = {
      start_date: startOfDay.toISOString().split('T')[0],
      end_date: endOfDay.toISOString().split('T')[0],
    };

    const response = await axios.post(`${FASTAPI_BASE_URL}/emails/summarize`, null, {
      params,
    });

    res.json({
      email,
      date,
      data: response.data,
    });
  } catch (error) {
    console.error('Error fetching emails by date:', error.message);
    res.status(500).json({
      error: 'Failed to fetch emails',
      details: error.message,
    });
  }
});

// Get emails by date range
app.get('/api/emails/by-range', async (req, res) => {
  try {
    const { email, startDate, endDate } = req.query;

    if (!email || !startDate || !endDate) {
      return res.status(400).json({ error: 'Email, startDate, and endDate are required' });
    }

    if (!users.has(email)) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }

    const params = {
      start_date: startDate,
      end_date: endDate,
    };

    const response = await axios.post(`${FASTAPI_BASE_URL}/emails/summarize`, null, {
      params,
    });

    res.json({
      email,
      range: { startDate, endDate },
      data: response.data,
    });
  } catch (error) {
    console.error('Error fetching emails by range:', error.message);
    res.status(500).json({
      error: 'Failed to fetch emails',
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Node.js backend listening on port ${PORT}`);
  console.log(`FastAPI backend URL: ${FASTAPI_BASE_URL}`);
});
